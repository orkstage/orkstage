import type { DeploymentJob } from '@orkstage/contracts';
import type { Queue } from 'bullmq';
import { notify, systemAudit, type WorkerContext } from './context.js';

/** Fails a deployment the way the runner does (instance state, notification, audit). */
export type AbandonDeployment = (deploymentId: string, message: string) => Promise<void>;

/**
 * Periodic upkeep, run after each health tick:
 * - automated incidents whose instance was destroyed, or whose resource no longer exists, are
 *   resolved (the health monitor only looks at live instances, so nothing else would);
 * - health check history older than the retention period is deleted;
 * - deployments left RUNNING by a worker that died (no live job, no recent event) are failed, so
 *   the instance is not stuck in a busy state forever.
 */
export class Housekeeping {
  constructor(
    private readonly ctx: WorkerContext,
    private readonly deployments: Queue<DeploymentJob>,
    private readonly abandon: AbandonDeployment,
  ) {}

  async run(now = new Date()): Promise<void> {
    await this.resolveOrphanIncidents();
    await this.pruneHealthHistory(now);
    await this.reapStuckDeployments(now);
  }

  async resolveOrphanIncidents(): Promise<number> {
    const { prisma } = this.ctx;
    const open = await prisma.incident.findMany({ where: { source: 'AUTOMATED', status: { not: 'RESOLVED' }, dedupKey: { startsWith: 'health:' } } });
    let resolved = 0;
    for (const incident of open) {
      const [, instanceId, resourceId] = incident.dedupKey!.split(':') as [string, string, string];
      const instance = await prisma.instance.findUnique({ where: { id: instanceId }, select: { status: true } });
      const resource = await prisma.instanceResource.findUnique({ where: { instanceId_resourceId: { instanceId, resourceId } }, select: { status: true } });
      const reason = !instance || instance.status === 'DESTROYED' ? 'The instance was destroyed.' : !resource || resource.status === 'DELETED' ? `${resourceId} no longer exists.` : null;
      if (!reason) continue;
      await prisma.incident.update({
        where: { id: incident.id },
        data: { status: 'RESOLVED', resolvedAt: new Date(), updates: { create: { status: 'RESOLVED', message: `Resolved automatically: ${reason}` } } },
      });
      await notify(this.ctx, { tenantId: incident.tenantId, event: 'incident.resolved', title: `Resolved: ${incident.title}`, body: reason, link: `/incidents/${incident.id}`, data: { incidentId: incident.id, instanceId } });
      await systemAudit(this.ctx, { tenantId: incident.tenantId, resourceType: 'Incident', resourceId: incident.id, action: 'AUTO_RESOLVE', changes: { reason } });
      resolved++;
    }
    return resolved;
  }

  async pruneHealthHistory(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - this.ctx.config.HEALTH_HISTORY_DAYS * 86_400_000);
    const { count } = await this.ctx.prisma.healthCheckResult.deleteMany({ where: { checkedAt: { lt: cutoff } } });
    return count;
  }

  async reapStuckDeployments(now: Date): Promise<number> {
    const { prisma } = this.ctx;
    // Longer than any single OpenTofu command may run, plus a margin for the phases around it.
    const quietMs = (this.ctx.config.TOFU_TIMEOUT_MINUTES + 15) * 60_000;
    const running = await prisma.deployment.findMany({ where: { status: 'RUNNING', startedAt: { lt: new Date(now.getTime() - quietMs) } }, select: { id: true } });
    if (running.length === 0) return 0;
    const live = new Set((await this.deployments.getJobs(['active', 'waiting', 'delayed', 'prioritized'])).map((j) => j?.data?.deploymentId));
    let reaped = 0;
    for (const d of running) {
      if (live.has(d.id)) continue;
      const last = await prisma.deploymentEvent.findFirst({ where: { deploymentId: d.id }, orderBy: { id: 'desc' }, select: { at: true } });
      if (last && last.at.getTime() > now.getTime() - quietMs) continue;
      await this.abandon(d.id, 'The worker running this deployment stopped and it made no progress since. Review the resources, then retry.');
      reaped++;
    }
    return reaped;
  }
}
