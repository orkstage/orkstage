import type { CloudCapability } from '@orkstage/cloud-core';
import type { Entitlements } from '@orkstage/domain';
import type { EnvironmentTemplate, TemplateResource } from '@orkstage/templates';
import { effectiveProvider } from './connectivity.js';
import type {
  CostEstimate,
  EnvironmentKind,
  PolicyConfig,
  PolicyResult,
  ResolvedConnectivity,
  ResolvedResource,
} from './types.js';

export interface PolicyInput {
  template: EnvironmentTemplate;
  environment: EnvironmentKind;
  entitlements: Entitlements;
  resources: ResolvedResource[];
  sources: Map<string, TemplateResource>;
  capabilities: Map<string, CloudCapability>;
  connectivity: ResolvedConnectivity[];
  cost: CostEstimate;
  config: PolicyConfig;
  targetRegions: Map<string, string[]>;
}

type Policy = (input: PolicyInput) => PolicyResult[];

const pass = (policy: string, message: string): PolicyResult => ({ policy, status: 'pass', message });

/**
 * Built-in governance policies (spec §33). Each returns explicit results so the operator sees
 * what was checked, not only what failed. Custom templates go through the same policies and
 * cannot bypass them (spec §72).
 */
export const POLICIES: Record<string, Policy> = {
  /**
   * A public database fails, unless the template declares that a resource on another provider
   * reaches it over TLS (connectivity mode `secure`): that is how a Vercel or Render app talks to
   * a database elsewhere. It is then a warning, so the exposure stays visible in every plan.
   */
  'no-public-database': ({ sources, connectivity }) => {
    const exposed = [...sources.values()].filter((r) => r.type === 'database.postgresql' && r.publicAccess);
    if (!exposed.length) return [pass('no-public-database', 'No database is publicly accessible.')];
    return exposed.map((r) => {
      const crossCloudTls = connectivity.filter((c) => c.to === r.id && c.crossCloud && (c.strategy === 'public-tls' || c.strategy === 'public-tls-allowlist'));
      return crossCloudTls.length
        ? { policy: 'no-public-database', status: 'warn' as const, resourceId: r.id, message: `Database "${r.id}" is reachable over TLS for ${crossCloudTls.map((c) => c.from).join(', ')} on another provider.` }
        : { policy: 'no-public-database', status: 'fail' as const, resourceId: r.id, message: `Database "${r.id}" must not be publicly accessible.` };
    });
  },

  'no-public-storage': ({ sources }) => {
    const bad = [...sources.values()].filter((r) => r.type === 'object-storage' && r.publicAccess);
    return bad.length
      ? bad.map((r) => ({ policy: 'no-public-storage', status: 'fail' as const, resourceId: r.id, message: `Bucket "${r.id}" must block public access.` }))
      : [pass('no-public-storage', 'Object storage blocks public access.')];
  },

  'production-backups': ({ sources, environment }) => {
    if (environment !== 'production') return [pass('production-backups', 'Not a production environment.')];
    const bad = [...sources.values()].filter((r) => r.type === 'database.postgresql' && !r.backup.enabled);
    return bad.length
      ? bad.map((r) => ({ policy: 'production-backups', status: 'fail' as const, resourceId: r.id, message: `Production database "${r.id}" must have backups enabled.` }))
      : [pass('production-backups', 'Production databases have backups.')];
  },

  'non-production-template': ({ template, environment }) =>
    template.metadata.nonProduction && environment === 'production'
      ? [{ policy: 'non-production-template', status: 'fail', message: `Template ${template.metadata.name} is not for production use.` }]
      : template.metadata.nonProduction
        ? [{ policy: 'non-production-template', status: 'warn', message: 'This template is for validation/sandbox use only.' }]
        : [pass('non-production-template', 'Template is production-grade.')],

  'encryption-required': ({ resources, capabilities }) => {
    const bad = resources.filter((r) => capabilities.get(r.id)?.supportsEncryption === false);
    return bad.length
      ? bad.map((r) => ({ policy: 'encryption-required', status: 'fail' as const, resourceId: r.id, message: `${r.capabilityName} does not support encryption at rest.` }))
      : [pass('encryption-required', 'All resources support encryption.')];
  },

  'allowed-regions': ({ resources, config, targetRegions }) => {
    const results: PolicyResult[] = [];
    for (const r of resources) {
      const targetAllowed = targetRegions.get(r.targetId) ?? [];
      if (!targetAllowed.includes(r.region)) {
        results.push({ policy: 'allowed-regions', status: 'fail', resourceId: r.id, message: `${r.region} is not allowed for target ${r.targetName}.` });
      } else if (config.allowedRegions && !config.allowedRegions.includes(r.region)) {
        results.push({ policy: 'allowed-regions', status: 'fail', resourceId: r.id, message: `${r.region} is not an approved platform region.` });
      }
    }
    return results.length ? dedupe(results) : [pass('allowed-regions', 'All regions are approved.')];
  },

  'max-replicas': ({ sources, config }) => {
    if (config.maxReplicas === undefined) return [];
    const bad = [...sources.values()].filter(
      (r) => r.type === 'compute.container-service' && (r.autoscaling?.maxReplicas ?? r.replicas) > config.maxReplicas!,
    );
    return bad.length
      ? bad.map((r) => ({ policy: 'max-replicas', status: 'fail' as const, resourceId: r.id, message: `Service "${r.id}" exceeds the platform maximum of ${config.maxReplicas} replicas.` }))
      : [pass('max-replicas', 'Replica counts are within platform limits.')];
  },

  'max-monthly-cost': ({ cost, config }) => {
    if (config.maxMonthlyCostUsd === undefined) return [];
    return cost.total > config.maxMonthlyCostUsd
      ? [{ policy: 'max-monthly-cost', status: 'fail', message: `Estimated $${cost.total}/month exceeds the $${config.maxMonthlyCostUsd} budget.` }]
      : [pass('max-monthly-cost', `Estimated $${cost.total}/month is within budget.`)];
  },

  'multi-cloud-entitlement': ({ resources, entitlements }) => {
    const providers = new Set(resources.map(effectiveProvider));
    // Multi-region means several regions on the same provider; one region per provider is
    // just multi-cloud.
    const regionsByProvider = new Map<string, Set<string>>();
    for (const r of resources) {
      const p = effectiveProvider(r);
      if (!regionsByProvider.has(p)) regionsByProvider.set(p, new Set());
      regionsByProvider.get(p)!.add(r.region);
    }
    const results: PolicyResult[] = [];
    if (providers.size > 1 && !entitlements.multiCloud) {
      results.push({ policy: 'multi-cloud-entitlement', status: 'fail', message: `Placing resources on ${[...providers].join(', ')} requires a plan with multi-cloud.` });
    }
    for (const [provider, regions] of regionsByProvider) {
      if (regions.size > 1 && !entitlements.multiRegion) {
        results.push({ policy: 'multi-cloud-entitlement', status: 'fail', message: `Using ${provider} regions ${[...regions].join(', ')} requires a plan with multi-region.` });
      }
    }
    return results.length ? results : [pass('multi-cloud-entitlement', 'Placement fits the plan.')];
  },

  'cross-cloud-connectivity': ({ connectivity }) => {
    const results: PolicyResult[] = [];
    for (const c of connectivity) {
      if (c.strategy === 'unsatisfiable') {
        results.push({ policy: 'cross-cloud-connectivity', status: 'fail', resourceId: c.from, message: `${c.from} → ${c.to} requires private connectivity across clouds. Use private-preferred, or place both on the same provider.` });
      } else if (c.crossCloud) {
        results.push({ policy: 'cross-cloud-connectivity', status: 'warn', resourceId: c.from, message: `${c.from} → ${c.to} crosses clouds via ${c.strategy}; expect added latency and egress charges.` });
      }
    }
    return results.length ? results : [pass('cross-cloud-connectivity', 'No cross-cloud traffic.')];
  },
};

function dedupe(results: PolicyResult[]): PolicyResult[] {
  const seen = new Set<string>();
  return results.filter((r) => {
    const key = `${r.policy}:${r.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function evaluatePolicies(input: PolicyInput): PolicyResult[] {
  return Object.values(POLICIES).flatMap((policy) => policy(input));
}
