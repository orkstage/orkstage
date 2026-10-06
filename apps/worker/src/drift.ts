import type { DriftChange, ResourceOutputs } from '@co/cloud-core';
import type { InstanceResource } from '@co/database';
import { idempotencyKeyFor, type ResolvedInfrastructure } from '@co/provisioning';
import { toCloudTarget } from '@co/runtime';
import { randomUUID } from 'node:crypto';
import { notify, systemAudit, type WorkerContext } from './context.js';

/**
 * `<resource type>.<attribute>` pairs emulators report as changed although nobody touched them
 * (values they do not round-trip between create and later reads). Observed on MiniStack; applied
 * to emulator targets only — real providers get no filtering.
 */
const EMULATOR_NOISE = new Set([
  'aws_lb_target_group.load_balancer_arns',
  'aws_iam_role.inline_policy',
  'aws_iam_role.managed_policy_arns',
  'aws_ecs_service.capacity_provider_strategy',
  'aws_elasticache_subnet_group.subnet_ids',
]);

/** `module.resource.aws_iam_role.execution[0]` → `aws_iam_role`. */
const resourceType = (address: string) => address.replace(/\[[^\]]*\]/g, '').split('.').at(-2) ?? '';

/** Drops attributes that are noise for this target; a change left with no attribute is not drift. */
export function meaningfulDrift(changes: DriftChange[], emulator: boolean): DriftChange[] {
  if (!emulator) return changes;
  return changes
    .map((c) => ({ ...c, attributes: c.attributes.filter((a) => !EMULATOR_NOISE.has(`${resourceType(c.address)}.${a}`)) }))
    .filter((c) => c.action === 'delete' || c.attributes.length > 0);
}

export interface DriftScanResult {
  checked: number;
  drifted: number;
  skipped: number;
}

/**
 * Scheduled drift detection for adapters that observe real infrastructure (spec §31). Each
 * applied resource gets a refresh-only plan from the snapshot it was applied with: anything it
 * reports was changed outside OrkStage. Resources with pending changes are skipped (that is a
 * deployment, not drift). Simulated adapters report drift on every health check instead.
 */
export class DriftDetector {
  constructor(private readonly ctx: WorkerContext) {}

  async scan(): Promise<DriftScanResult> {
    const { prisma, registry } = this.ctx;
    const result: DriftScanResult = { checked: 0, drifted: 0, skipped: 0 };
    const instances = await prisma.instance.findMany({
      where: { status: { in: ['READY', 'DEGRADED'] } },
      include: { resources: { where: { status: 'ACTIVE' } } },
    });
    const targets = new Map((await prisma.cloudTarget.findMany({ where: { status: 'ACTIVE' } })).map((t) => [t.id, t]));

    for (const instance of instances) {
      const planned = instance.resources.filter((r) => registry.has(r.provider) && !registry.get(r.provider).simulated && registry.get(r.provider).detectDrift);
      if (planned.length === 0) continue;
      const last = await prisma.deployment.findFirst({
        where: { instanceId: instance.id, kind: 'APPLY', status: 'SUCCEEDED' },
        orderBy: { finishedAt: 'desc' },
        select: { resolved: true },
      });
      const snapshot = last?.resolved as unknown as ResolvedInfrastructure | undefined;
      if (!snapshot) continue;
      const rows = new Map(instance.resources.map((r) => [r.resourceId, r]));

      for (const row of planned) {
        const outcome = await this.check(instance.tenantId, instance.id, row, snapshot, rows, targets);
        if (outcome === 'skipped') result.skipped++;
        else {
          result.checked++;
          if (outcome === 'drifted') result.drifted++;
        }
      }
    }
    return result;
  }

  private async check(
    tenantId: string,
    instanceId: string,
    row: InstanceResource,
    snapshot: ResolvedInfrastructure,
    rows: Map<string, InstanceResource>,
    targets: Map<string, Parameters<typeof toCloudTarget>[0]>,
  ): Promise<'in-sync' | 'drifted' | 'skipped'> {
    const { prisma, registry } = this.ctx;
    const r = snapshot.resources.find((x) => x.id === row.resourceId);
    const target = targets.get(row.targetId);
    // Not applied from this snapshot (a change is pending) or dependencies missing: not drift.
    if (!r || !target || row.idempotencyKey !== idempotencyKeyFor(tenantId, instanceId, r) || r.dependsOn.some((d) => !rows.has(d))) return 'skipped';

    const ctx = { target: toCloudTarget(target), region: row.region, correlationId: `drift-${randomUUID()}` };
    let changes: DriftChange[];
    try {
      changes = await registry.get(row.provider).detectDrift!(ctx, {
        resourceId: r.id,
        serviceKind: r.type,
        capability: r.capability,
        name: r.name,
        tags: r.tags,
        spec: r.spec,
        dependencyOutputs: Object.fromEntries(r.dependsOn.map((d) => [d, rows.get(d)!.outputs as ResourceOutputs])),
        idempotencyKey: row.idempotencyKey,
      });
    } catch (err) {
      this.ctx.logger.warn({ instanceId, resourceId: row.resourceId, err: (err as Error).message }, 'drift check failed');
      await prisma.instanceResource.update({ where: { id: row.id }, data: { driftCheckedAt: new Date(), driftDetails: { error: (err as Error).message.slice(0, 300) } } });
      return 'skipped';
    }

    const emulator = Boolean((target.config as { emulator?: string } | null)?.emulator);
    const actions = meaningfulDrift(changes, emulator);
    const drifted = actions.length > 0;
    await prisma.instanceResource.update({
      where: { id: row.id },
      data: { drift: drifted ? 'DRIFT_DETECTED' : 'IN_SYNC', driftCheckedAt: new Date(), driftDetails: { actions } as object },
    });
    if (drifted && row.drift !== 'DRIFT_DETECTED') {
      await systemAudit(this.ctx, { tenantId, resourceType: 'InstanceResource', resourceId: `${instanceId}/${row.resourceId}`, action: 'DRIFT_DETECTED', changes: { actions: actions.length } });
      await notify(this.ctx, {
        tenantId,
        event: 'instance.drift_detected',
        title: `Drift detected on ${row.resourceId}`,
        body: `${actions.length} change(s) were made outside OrkStage. Redeploy to restore the template's configuration.`,
        link: `/instances/${instanceId}`,
        data: { instanceId, resourceId: row.resourceId, changes: actions.length },
      });
    }
    return drifted ? 'drifted' : 'in-sync';
  }
}
