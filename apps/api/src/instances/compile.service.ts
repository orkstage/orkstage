import type { PreviewDto } from '@co/contracts';
import type { PrismaClient } from '@co/database';
import type { Entitlements, PlanCode } from '@co/domain';
import {
  compileInfrastructure,
  diffPlan,
  renderPlan,
  type EnvironmentKind,
  type KnownResource,
  type PolicyConfig,
  type ResolvedInfrastructure,
  type SlotBinding,
} from '@co/provisioning';
import { toCloudTarget } from '@co/runtime';
import { applyVariables, environmentTemplate, type VariableValues } from '@co/templates';
import { Inject, Injectable } from '@nestjs/common';
import { unprocessable } from '../common/errors.js';
import { Adapters, PRISMA } from '../infra/infra.module.js';

export interface CompileRequest {
  tenantId: string;
  instanceId: string;
  instanceSlug: string;
  environment: string;
  templateVersionId: string;
  variables: VariableValues;
  bindings: Record<string, { targetId: string; region: string }>;
}

/**
 * Loads everything the compiler needs from the database (template version, plan, targets,
 * image catalog, platform policy) and runs it. Pure orchestration: all rules live in
 * @co/templates and @co/provisioning.
 */
@Injectable()
export class CompileService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly adapters: Adapters,
  ) {}

  async compile(req: CompileRequest): Promise<ResolvedInfrastructure> {
    const [version, tenant, policySetting] = await Promise.all([
      this.prisma.templateVersion.findUniqueOrThrow({ where: { id: req.templateVersionId } }),
      this.prisma.tenant.findUniqueOrThrow({ where: { id: req.tenantId }, include: { plan: true } }),
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

    return compileInfrastructure(
      {
        template: applied.template,
        plan: { code: tenant.plan.code as PlanCode, entitlements: tenant.plan.entitlements as unknown as Entitlements },
        organizationId: tenant.organizationId,
        tenant: { id: tenant.id, slug: tenant.slug },
        instance: { id: req.instanceId, slug: req.instanceSlug, environment: req.environment as EnvironmentKind },
        bindings,
        images,
        policy: (policySetting?.value ?? {}) as PolicyConfig,
      },
      this.adapters.registry,
    );
  }

  async knownResources(instanceId: string): Promise<KnownResource[]> {
    const rows = await this.prisma.instanceResource.findMany({ where: { instanceId, status: { in: ['ACTIVE', 'FAILED'] } } });
    return rows.map((r) => ({
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
