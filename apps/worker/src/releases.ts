// SPDX-License-Identifier: AGPL-3.0-only
import type { ResourceOutputs } from '@orkstage/cloud-core';
import type { DeploymentJob } from '@orkstage/contracts';
import type { Deployment } from '@orkstage/database';
import type { ReleaseSettings } from '@orkstage/domain';
import type { ResolvedInfrastructure } from '@orkstage/provisioning';
import { InstanceBusyError, recordRollback, rollbackTarget, toCloudTarget } from '@orkstage/runtime';
import type { Queue } from 'bullmq';
import { notify, systemAudit, type WorkerContext } from './context.js';

/** Consecutive failed checks of a critical resource that end a bake period without an alert rule. */
const UNHEALTHY_CHECKS = 3;

/**
 * Watches deployments through their bake period (ADR 0009), after each health tick. An automated
 * incident on the instance, or a critical resource failing its checks, during the period fails the
 * bake and, when the deployment allows it, rolls the instance back to the last deployment that
 * stayed healthy through its own bake period. A period that passes verifies the deployment and
 * promotes a canary or blue/green release.
 */
export class ReleaseWatcher {
  constructor(
    private readonly ctx: WorkerContext,
    private readonly deployments: Queue<DeploymentJob>,
  ) {}

  async run(now = new Date()): Promise<void> {
    const watching = await this.ctx.prisma.deployment.findMany({
      where: { kind: 'APPLY', status: 'SUCCEEDED', bakeUntil: { not: null }, verifiedAt: null, bakeFailedAt: null },
      orderBy: { queuedAt: 'asc' },
      take: 100,
    });
    for (const d of watching) {
      try {
        await this.watch(d, now);
      } catch (err) {
        this.ctx.logger.warn({ deploymentId: d.id, err: (err as Error).message }, 'release watch failed');
      }
    }
  }

  /**
   * After a failed apply: a release that asked to be watched (a bake period) and failed its health
   * checks in the verify phase is rolled back now, so a bad canary does not keep its share of
   * traffic. Other failures (provisioning, validation) leave the instance to its people.
   */
  async afterFailure(deploymentId: string, now = new Date()): Promise<void> {
    const d = await this.ctx.prisma.deployment.findUnique({ where: { id: deploymentId } });
    const release = d?.release as ReleaseSettings | null | undefined;
    if (d?.kind !== 'APPLY' || d.errorClass !== 'HEALTH_CHECK_FAILED' || !release || release.bakeMinutes <= 0) return;
    await this.fail(d, `The release failed its health checks: ${d.errorMessage ?? 'unhealthy'}`, now);
  }

  private async watch(d: Deployment, now: Date): Promise<void> {
    const { prisma } = this.ctx;
    const newer = await prisma.deployment.findFirst({ where: { instanceId: d.instanceId, queuedAt: { gt: d.queuedAt } }, select: { id: true } });
    if (newer) {
      // What runs now is the newer deployment's to answer for.
      await prisma.deployment.updateMany({ where: { id: d.id, verifiedAt: null, bakeFailedAt: null }, data: { bakeUntil: null, bakeFailure: 'Watching stopped: a newer deployment started.' } });
      return;
    }
    const breach = await this.breach(d);
    if (breach) return this.fail(d, breach, now);
    if (now >= d.bakeUntil!) await this.verify(d, now);
  }

  /** Why the release is not healthy, or null. */
  private async breach(d: Deployment): Promise<string | null> {
    const { prisma } = this.ctx;
    const since = d.finishedAt ?? d.queuedAt;
    const incident = await prisma.incident.findFirst({ where: { instanceId: d.instanceId, source: 'AUTOMATED', openedAt: { gte: since } }, orderBy: { openedAt: 'asc' } });
    if (incident) return `An incident opened during the bake period: ${incident.title}.`;
    const failing = await prisma.instanceResource.findFirst({ where: { instanceId: d.instanceId, status: 'ACTIVE', critical: true, consecutiveHealthFailures: { gte: UNHEALTHY_CHECKS } } });
    if (failing) return `${failing.resourceId} failed ${failing.consecutiveHealthFailures} health checks in a row during the bake period.`;
    return null;
  }

  private async fail(d: Deployment, reason: string, now: Date): Promise<void> {
    const { prisma } = this.ctx;
    const claimed = await prisma.deployment.updateMany({ where: { id: d.id, verifiedAt: null, bakeFailedAt: null }, data: { bakeFailedAt: now, bakeFailure: reason } });
    if (claimed.count === 0) return; // another worker got here first
    await this.event(d.id, 'warn', reason);
    const release = d.release as ReleaseSettings | null;

    let rollbackId: string | null = null;
    let outcome = 'Automatic rollback is off for this deployment: roll back by hand if needed.';
    if (release?.autoRollback !== false) {
      const target = await rollbackTarget(prisma, d.instanceId, { before: d.queuedAt });
      if (!target.ok) {
        outcome = `Not rolled back automatically: ${target.reason}`;
      } else {
        const instance = await prisma.instance.findUniqueOrThrow({ where: { id: d.instanceId } });
        try {
          const rollback = await recordRollback(prisma, { instance, target: target.deployment, requestedById: null, requestedBy: 'automatic rollback', correlationId: d.correlationId });
          await this.deployments.add('deployment', { deploymentId: rollback.id }, { jobId: `${rollback.id}--run`, attempts: 1, removeOnComplete: 1000, removeOnFail: 5000 });
          rollbackId = rollback.id;
          outcome = `Rolling back to deployment ${target.deployment.id} (rollback ${rollback.id}).`;
        } catch (err) {
          if (!(err instanceof InstanceBusyError)) throw err;
          outcome = 'Not rolled back automatically: another operation holds the instance.';
        }
      }
    }
    await this.event(d.id, rollbackId ? 'warn' : 'error', outcome);
    await prisma.deployment.update({ where: { id: d.id }, data: { bakeFailure: `${reason} ${outcome}` } });
    await notify(this.ctx, {
      tenantId: d.tenantId,
      event: 'deployment.bake_failed',
      title: rollbackId ? 'Release rolled back' : 'Release failed its bake period',
      body: `${reason} ${outcome}`,
      link: `/deployments/${rollbackId ?? d.id}`,
      data: { deploymentId: d.id, instanceId: d.instanceId, rolledBack: rollbackId !== null, rollbackDeploymentId: rollbackId },
    });
    await systemAudit(this.ctx, { tenantId: d.tenantId, resourceType: 'Deployment', resourceId: d.id, action: 'BAKE_FAILED', correlationId: d.correlationId, changes: { reason, rollbackDeploymentId: rollbackId } });
  }

  private async verify(d: Deployment, now: Date): Promise<void> {
    const { prisma, registry } = this.ctx;
    const claimed = await prisma.deployment.updateMany({ where: { id: d.id, verifiedAt: null, bakeFailedAt: null }, data: { verifiedAt: now } });
    if (claimed.count === 0) return;
    const release = d.release as ReleaseSettings | null;
    let promoted = 0;
    if (release && release.strategy !== 'rolling') {
      const resolved = d.resolved as unknown as ResolvedInfrastructure;
      for (const r of resolved.resources.filter((x) => x.type === 'compute.container-service')) {
        const adapter = registry.has(r.provider) ? registry.get(r.provider) : undefined;
        if (!adapter?.promoteRelease) continue;
        const target = await prisma.cloudTarget.findUniqueOrThrow({ where: { id: r.targetId } });
        const ctx = { target: toCloudTarget(target), region: r.region, correlationId: d.correlationId };
        const ref = { resourceId: r.id, serviceKind: r.type, capability: r.capability, name: r.name };
        await adapter.promoteRelease(ctx, ref);
        const state = await adapter.getResource(ctx, ref);
        if (state.exists) {
          await prisma.instanceResource.updateMany({ where: { instanceId: d.instanceId, resourceId: r.id }, data: { outputs: state.outputs as ResourceOutputs } });
        }
        promoted++;
      }
    }
    const minutes = release?.bakeMinutes ?? 0;
    await this.event(d.id, 'info', `Verified: healthy through the ${minutes} minute bake period${promoted ? `; the new release now takes all traffic on ${promoted} service(s)` : ''}.`);
    await systemAudit(this.ctx, { tenantId: d.tenantId, resourceType: 'Deployment', resourceId: d.id, action: 'VERIFIED', correlationId: d.correlationId, changes: { bakeMinutes: minutes, promoted } });
  }

  private async event(deploymentId: string, level: 'info' | 'warn' | 'error', message: string): Promise<void> {
    await this.ctx.prisma.deploymentEvent.create({ data: { deploymentId, level, stepKey: null, message } });
  }
}
