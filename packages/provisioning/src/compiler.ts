// SPDX-License-Identifier: AGPL-3.0-only
import { resolveCapability, type AdapterRegistry, type CloudCapability, type CloudTarget } from '@orkstage/cloud-core';
import { desiredStateHash, resourceName, standardTags } from '@orkstage/domain';
import {
  activeResources,
  buildDependencyGraph,
  topologicalLevels,
  hasErrors,
  validateLimits,
  validateSemantics,
  type TemplateResource,
  type ValidationIssue,
} from '@orkstage/templates';
import { resolveConnectivity, wireAllowlist } from './connectivity.js';
import { categoryOf, estimateResourceMonthly, summarizeCost } from './cost.js';
import { evaluatePolicies } from './policies.js';
import type { CompileInput, CostLine, ResolvedConnectivity, ResolvedInfrastructure, ResolvedResource } from './types.js';

/** Provider name length limits for physical names (conservative common denominator). */
const NAME_LIMIT = 48;

/** Logical requirements that a capability must support, derived from the resource spec. */
export function requiredFeatures(r: TemplateResource): string[] {
  switch (r.type) {
    case 'compute.container-service':
      return r.autoscaling ? ['autoscaling'] : [];
    case 'database.postgresql':
      return r.highAvailability === 'none' ? [] : [`ha:${r.highAvailability}`];
    case 'network':
      return [...(r.availabilityZones > 1 ? ['multi-az'] : []), ...(r.natGateway ? ['nat-gateway'] : [])];
    case 'cache.redis':
      return r.replicas > 0 ? ['replicas'] : [];
    case 'queue':
      return r.fifo ? ['fifo'] : [];
    case 'object-storage':
      return r.versioning ? ['versioning'] : [];
    case 'dns':
      return r.customDomain === 'disabled' ? [] : ['custom-domain'];
    default:
      return [];
  }
}

function isCritical(r: TemplateResource): boolean {
  return 'critical' in r ? Boolean(r.critical) : true;
}

/**
 * Compiles a logical template into a resolved, provider-specific infrastructure description:
 * template → placement → capability → names/tags/spec → DAG → connectivity → cost → policy
 * (spec §18). It performs no cloud mutation; every failure here happens before anything is
 * created.
 */
export function compileInfrastructure(input: CompileInput, registry: AdapterRegistry): ResolvedInfrastructure {
  const { template, limits, features, tenant, instance, bindings } = input;
  const issues: ValidationIssue[] = [...validateSemantics(template)];
  if (!hasErrors(issues)) issues.push(...validateLimits(template, { limits, features }));

  const capabilityIssue = (resourceId: string, message: string, suggestions: string[] = []) =>
    issues.push({ stage: 'capability', severity: 'error', code: 'CAPABILITY_UNAVAILABLE', message, path: `spec.resources.${resourceId}`, suggestions });

  const slots = new Map(template.spec.placements.map((p) => [p.name, p]));
  const resources: ResolvedResource[] = [];
  const sources = new Map<string, TemplateResource>();
  const capabilities = new Map<string, CloudCapability>();
  const targets: Record<string, CloudTarget> = {};
  const costLines: CostLine[] = [];
  const graph = issues.length === 0 ? buildDependencyGraph(template) : new Map<string, Set<string>>();

  for (const r of activeResources(template)) {
    const binding = bindings[r.placement];
    if (!binding) {
      capabilityIssue(r.id, `Placement slot "${r.placement}" is not bound to a cloud target.`, ['Choose a cloud target and region for this slot.']);
      continue;
    }
    const { target, region } = binding;
    const slot = slots.get(r.placement);
    if (slot && slot.providers.length > 0 && !slot.providers.includes(target.provider)) {
      capabilityIssue(r.id, `Slot "${r.placement}" allows ${slot.providers.join(', ')}, but target ${target.name} is ${target.provider}.`);
      continue;
    }
    if (input.providerEnabled && !input.providerEnabled(target.provider)) {
      issues.push({
        stage: 'capability',
        severity: 'error',
        code: 'PROVIDER_DISABLED',
        message: `${target.provider} is disabled on this platform, so "${r.id}" cannot be placed on ${target.name}.`,
        path: `spec.resources.${r.id}`,
        suggestions: ['Bind this slot to a target of an enabled provider.', 'Ask a platform administrator to enable the provider (feature flags).'],
      });
      continue;
    }
    if (!registry.has(target.provider)) {
      capabilityIssue(r.id, `No adapter is installed for provider ${target.provider}.`);
      continue;
    }

    const catalog = registry.get(target.provider).capabilities(target);
    const resolution = resolveCapability(catalog, {
      serviceKind: r.type,
      implementation: r.implementation,
      features: requiredFeatures(r),
      region,
    });
    if (!resolution.ok) {
      capabilityIssue(r.id, `${r.id}: ${resolution.reason}`, resolution.suggestions);
      continue;
    }
    const cap = resolution.capability;
    targets[target.id] = target;
    sources.set(r.id, r);
    capabilities.set(r.id, cap);

    const spec = specFor(r, input);
    if (r.type === 'compute.container-service' && input.images && !input.images[r.image]) {
      issues.push({ stage: 'semantic', severity: 'error', code: 'IMAGE_NOT_IN_CATALOG', message: `Image ${r.image} for "${r.id}" is not in the application catalog.`, path: `spec.resources.${r.id}.image` });
    }
    const name = resourceName({ tenantSlug: tenant.slug, instanceSlug: instance.slug, resourceId: r.id }, NAME_LIMIT);
    const resolved: Omit<ResolvedResource, 'specHash'> = {
      id: r.id,
      type: r.type,
      slot: r.placement,
      provider: target.provider,
      simulatedProvider: target.provider === 'mock' ? cap.provider : undefined,
      targetId: target.id,
      targetName: target.name,
      region,
      capability: cap.capability,
      capabilityName: cap.displayName,
      name,
      tags: standardTags({
        organizationId: input.organizationId,
        tenantId: tenant.id,
        instanceId: instance.id,
        resourceId: r.id,
        environment: instance.environment,
        templateName: template.metadata.name,
        templateVersion: template.metadata.version,
      }),
      spec,
      dependsOn: [...(graph.get(r.id) ?? [])].sort(),
      critical: isCritical(r),
    };
    resources.push({
      ...resolved,
      specHash: desiredStateHash({ target: target.id, region, capability: cap.capability, name, spec }),
    });
    costLines.push({
      resourceId: r.id,
      category: categoryOf(r.type),
      provider: cap.provider,
      monthly: estimateResourceMonthly(r, cap),
      source: cap.pricing?.source ?? 'No pricing data',
    });
  }

  const byId = new Map(resources.map((r) => [r.id, r]));
  const connectivity: ResolvedConnectivity[] = template.spec.connectivity
    .filter((c) => byId.has(c.from) && byId.has(c.to))
    .map((c) => resolveConnectivity(c, byId.get(c.from)!, byId.get(c.to)!));
  // Allowlists change the database (a dependency on the consumer's network, the networks to allow):
  // its hash follows, so a new allowlist is a planned change.
  for (const link of connectivity) {
    const changed = wireAllowlist(link, resources);
    if (changed) {
      changed.specHash = desiredStateHash({ target: changed.targetId, region: changed.region, capability: changed.capability, name: changed.name, spec: changed.spec });
    }
  }

  const cost = summarizeCost(costLines);
  const policyResults =
    resources.length > 0
      ? evaluatePolicies({
          template,
          environment: instance.environment,
          features,
          resources,
          sources,
          capabilities,
          connectivity,
          cost,
          config: input.policy ?? {},
          targetRegions: new Map(Object.values(targets).map((t) => [t.id, t.allowedRegions])),
          targets: Object.values(targets),
        })
      : [];
  for (const p of policyResults) {
    if (p.status === 'fail') {
      issues.push({ stage: 'policy', severity: 'error', code: `POLICY_${p.policy.toUpperCase().replace(/-/g, '_')}`, message: p.message, path: p.resourceId ? `spec.resources.${p.resourceId}` : undefined });
    }
  }

  const valid = !issues.some((i) => i.severity === 'error');
  const levels = valid ? topologicalLevels(new Map(resources.map((r) => [r.id, new Set(r.dependsOn)]))) : [];

  return {
    template: { name: template.metadata.name, version: template.metadata.version },
    environment: instance.environment,
    resources,
    levels,
    connectivity,
    targets,
    policyResults,
    issues,
    cost,
    desiredStateHash: desiredStateHash(resources.map((r) => [r.id, r.specHash])),
    valid,
  };
}

/** Provider-neutral spec handed to adapters: the template fields minus orchestration metadata. */
function specFor(r: TemplateResource, input: CompileInput): Record<string, unknown> {
  const { id: _id, placement: _p, implementation: _i, enabled: _e, dependsOn: _d, overrides, ...rest } = r;
  const spec: Record<string, unknown> = { ...rest };
  if (overrides) spec.providerOverrides = overrides;
  if (r.type === 'compute.container-service' && input.images?.[r.image]) {
    const img = input.images[r.image]!;
    spec.image = `${img.uri}@${img.digest}`;
  }
  if (r.type === 'dns') spec.subdomainLabel = `${input.instance.slug}-${input.tenant.slug}`;
  if (r.type === 'ingress') {
    // Services attach to their ingress (not the other way round), so give each route the
    // routed service's port and health path up front.
    spec.routes = r.routes.map((route) => {
      const svc = input.template.spec.resources.find((x) => x.id === route.service);
      return svc?.type === 'compute.container-service'
        ? { ...route, port: svc.port, healthCheckPath: svc.healthCheckPath ?? '/' }
        : route;
    });
  }
  return spec;
}
