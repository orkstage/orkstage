// SPDX-License-Identifier: AGPL-3.0-only
import type { PreviewDto } from '@orkstage/contracts';
import type { PrismaClient } from '@orkstage/database';
import { isProviderEnabled, readTenantLimits, tenantFeatures } from '@orkstage/domain';
import {
  compileInfrastructure,
  diffPlan,
  effectivePolicy,
  renderPlan,
  type EnvironmentKind,
  type KnownResource,
  type PolicyConfig,
  type ResolvedInfrastructure,
  type SlotBinding,
} from '@orkstage/provisioning';
import { toCloudTarget } from '@orkstage/runtime';
import { applyVariables, environmentTemplate, type VariableValues } from '@orkstage/templates';
import { Inject, Injectable } from '@nestjs/common';
import { unprocessable } from '../common/errors.js';
import { FeatureFlagsService } from '../common/feature-flags.service.js';
import { Adapters, PRISMA } from '../infra/infra.module.js';
import { bindFromProfile, defaultProfile, serves, visibleTo } from './profiles.js';

export interface CompileRequest {
  tenantId: string;
  instanceId: string;
  instanceSlug: string;
  environment: string;
  templateVersionId: string;
  variables: VariableValues;
  bindings: Record<string, { targetId: string; region: string }>;
  /** The instance labels; read from the instance when omitted. */
  labels?: Record<string, string>;
}

/**
 * Loads everything the compiler needs from the database (template version, tenant limits, targets,
 * image catalog, platform policy) and runs it. Pure orchestration: all rules live in
 * @orkstage/templates and @orkstage/provisioning.
 */
@Injectable()
export class CompileService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly adapters: Adapters,
    private readonly flags: FeatureFlagsService,
  ) {}

  async compile(req: CompileRequest): Promise<ResolvedInfrastructure> {
    const [version, tenant, policySetting] = await Promise.all([
      this.prisma.templateVersion.findUniqueOrThrow({ where: { id: req.templateVersionId } }),
      this.prisma.tenant.findUniqueOrThrow({ where: { id: req.tenantId } }),
      this.prisma.platformSetting.findUnique({ where: { key: 'policy' } }),
    ]);

    const template = environmentTemplate.parse(version.document);
    const applied = applyVariables(template, req.variables);
    if (applied.issues.length > 0) {
      throw unprocessable('INVALID_VARIABLES', 'Some template variables are invalid.', { issues: applied.issues });
    }

    const targetIds = [...new Set(Object.values(req.bindings).map((b) => b.targetId))];
    const targets = await this.prisma.cloudTarget.findMany({ where: { id: { in: targetIds } } });
    const bindings: Record<string, SlotBinding> = {};
    for (const [slot, b] of Object.entries(req.bindings)) {
      const row = targets.find((t) => t.id === b.targetId);
      if (!row) throw unprocessable('UNKNOWN_TARGET', `Cloud target for slot "${slot}" does not exist.`);
      if (row.status !== 'ACTIVE') throw unprocessable('TARGET_DISABLED', `Cloud target ${row.name} is disabled.`);
      if (row.tenantId && row.tenantId !== req.tenantId) {
        throw unprocessable('TARGET_NOT_ASSIGNED', `Cloud target ${row.name} is not assigned to this tenant.`);
      }
      bindings[slot] = { target: toCloudTarget(row), region: b.region };
    }

    const apps = await this.prisma.application.findMany({
      include: { versions: { orderBy: { createdAt: 'desc' }, take: 1 } },
    });
    const images = Object.fromEntries(
      apps.filter((a) => a.versions[0]).map((a) => [`catalog://${a.name}`, { uri: a.versions[0]!.imageUri, digest: a.versions[0]!.digest }]),
    );

    const flags = await this.flags.forTenant(req.tenantId);
    const labels = req.labels ?? ((await this.prisma.instance.findUnique({ where: { id: req.instanceId }, select: { labels: true } }))?.labels as Record<string, string> | undefined) ?? {};
    // Verified custom domains (open item 9) join the spec of the resource that serves them.
    const domains = await this.prisma.domain.findMany({ where: { instanceId: req.instanceId, kind: 'CUSTOM', status: 'VERIFIED' }, orderBy: { hostname: 'asc' } });
    const customDomains: Record<string, string[]> = {};
    for (const d of domains) (customDomains[d.resourceId] ??= []).push(d.hostname);
    const customCertificatesIssued = Object.keys(customDomains).filter((resourceId) =>
      domains.filter((d) => d.resourceId === resourceId).every((d) => d.certificateStatus === 'ISSUED' || d.certificateStatus === 'EXPIRING'),
    );
    return compileInfrastructure(
      {
        template: applied.template,
        limits: readTenantLimits(tenant.limits),
        features: tenantFeatures(flags),
        organizationId: tenant.organizationId,
        tenant: { id: tenant.id, slug: tenant.slug },
        instance: { id: req.instanceId, slug: req.instanceSlug, environment: req.environment as EnvironmentKind, labels },
        bindings,
        images,
        // The platform policy, tightened by the tenant's (open item 12).
        policy: effectivePolicy((policySetting?.value ?? {}) as PolicyConfig, (tenant.policy ?? {}) as PolicyConfig),
        providerEnabled: (provider) => isProviderEnabled(flags, provider),
        customDomains,
        customCertificatesIssued,
      },
      this.adapters.registry,
    );
  }

  /**
   * The request's bindings plus, for every slot it left unbound, the target of the chosen profile,
   * or of the default profile of the instance's environment (ADR 0007). Called when an instance is
   * created; the bindings and the profile are stored with it, so editing the profile later never
   * moves an existing instance to another account.
   */
  async withProfileBindings(req: {
    tenantId: string;
    environment: string;
    templateVersionId: string;
    bindings: Record<string, { targetId: string; region: string }>;
    profileId?: string;
  }): Promise<{ bindings: Record<string, { targetId: string; region: string }>; profileId: string | null }> {
    const version = await this.prisma.templateVersion.findUniqueOrThrow({ where: { id: req.templateVersionId } });
    const template = environmentTemplate.parse(version.document);
    const unbound = template.spec.placements.filter((s) => !req.bindings[s.name]);
    const include = { targets: { include: { target: true } } } as const;
    let profile;
    if (req.profileId) {
      profile = await this.prisma.profile.findUnique({ where: { id: req.profileId }, include });
      if (!profile || !visibleTo(req.tenantId)(profile)) throw unprocessable('UNKNOWN_PROFILE', 'The profile does not exist or is not available to this tenant.');
      if (!serves(req.environment)(profile)) {
        throw unprocessable('PROFILE_ENVIRONMENT', `Profile ${profile.name} serves ${profile.environment}, not ${req.environment}.`);
      }
    } else {
      if (unbound.length === 0) return { bindings: req.bindings, profileId: null };
      const candidates = await this.prisma.profile.findMany({ where: { isDefault: true, OR: [{ tenantId: null }, { tenantId: req.tenantId }] }, include });
      profile = defaultProfile(candidates, req.tenantId, req.environment);
    }
    if (!profile) return { bindings: req.bindings, profileId: null };
    const picked = bindFromProfile(unbound, req.bindings, profile, req.tenantId, req.environment);
    // A profile asked for is always recorded; a default one only when it bound a slot.
    const used = Boolean(req.profileId) || Object.keys(picked).length > 0;
    return { bindings: { ...req.bindings, ...picked }, profileId: used ? profile.id : null };
  }

  async knownResources(instanceId: string): Promise<KnownResource[]> {
    const rows = await this.prisma.instanceResource.findMany({ where: { instanceId, status: { in: ['ACTIVE', 'FAILED'] } } });
    return rows.map((r) => ({
      drifted: r.drift === 'DRIFT_DETECTED',
      resourceId: r.resourceId,
      type: r.type,
      specHash: r.status === 'ACTIVE' ? r.specHash : null,
      targetId: r.targetId,
      region: r.region,
      provider: r.simulatedProvider ?? r.provider,
      capabilityName: r.capabilityName,
      name: r.name,
    }));
  }

  toPreview(resolved: ResolvedInfrastructure, known: KnownResource[], instanceName: string): PreviewDto {
    const plan = diffPlan(resolved, known);
    return {
      valid: resolved.valid,
      issues: resolved.issues,
      resources: resolved.resources.map((r) => ({
        id: r.id,
        type: r.type,
        slot: r.slot,
        provider: r.provider,
        simulatedProvider: r.simulatedProvider ?? null,
        targetName: r.targetName,
        region: r.region,
        capability: r.capability,
        capabilityName: r.capabilityName,
        name: r.name,
        dependsOn: r.dependsOn,
      })),
      levels: resolved.levels,
      connectivity: resolved.connectivity.map((c) => ({
        from: c.from,
        to: c.to,
        protocol: c.protocol,
        mode: c.mode,
        strategy: c.strategy,
        crossCloud: c.crossCloud,
        notes: c.notes,
      })),
      policyResults: resolved.policyResults,
      cost: resolved.cost,
      plan: { counts: plan.counts, risk: plan.risk, groups: plan.groups, crossCloud: plan.crossCloud, text: renderPlan(instanceName, plan) },
      simulated: resolved.resources.length > 0 && resolved.resources.every((r) => r.provider === 'mock'),
    };
  }
}
