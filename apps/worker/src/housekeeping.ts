// SPDX-License-Identifier: AGPL-3.0-only
import type { DeploymentJob } from '@orkstage/contracts';
import { Prisma } from '@orkstage/database';
import { platformMetrics } from '@orkstage/runtime';
import type { Queue } from 'bullmq';
import { notify, systemAudit, type WorkerContext } from './context.js';

/** Fails a deployment the way the runner does (instance state, notification, audit). */
export type AbandonDeployment = (deploymentId: string, message: string) => Promise<void>;

const DAY = 86_400_000;
/** Rows deleted per statement, and statements per table and run: long deletes never block the tick. */
const BATCH = 5000;
const MAX_BATCHES = 20;

/**
 * Periodic upkeep, run after each health tick:
 * - automated incidents whose instance was destroyed, or whose resource (or metric rule) no longer
 *   exists, are resolved (the health monitor only looks at live instances, so nothing else would);
 * - health check history older than the retention period is deleted;
 * - deployments left RUNNING by a worker that died (no live job, no recent event) are failed, so
 *   the instance is not stuck in a busy state forever;
 * - once an hour across all workers, old records are pruned: sessions and invitations 30 days after
 *   they ended, notifications and deliveries after NOTIFICATION_RETENTION_DAYS, deployment events
 *   after DEPLOYMENT_EVENT_RETENTION_DAYS (0 keeps them). The audit log is never pruned.
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
    await this.pruneRecords(now);
  }

  async resolveOrphanIncidents(): Promise<number> {
    const { prisma } = this.ctx;
    const open = await prisma.incident.findMany({
      where: { source: 'AUTOMATED', status: { not: 'RESOLVED' }, OR: [{ dedupKey: { startsWith: 'health:' } }, { dedupKey: { startsWith: 'metric:' } }] },
    });
    let resolved = 0;
    for (const incident of open) {
      // health:<instance>:<resource> or metric:<rule>:<instance>:<resource>
      const parts = incident.dedupKey!.split(':');
      const metric = parts[0] === 'metric';
      const [instanceId, resourceId] = (metric ? parts.slice(2) : parts.slice(1)) as [string, string];
      const instance = await prisma.instance.findUnique({ where: { id: instanceId }, select: { status: true } });
      const resource = await prisma.instanceResource.findUnique({ where: { instanceId_resourceId: { instanceId, resourceId } }, select: { status: true } });
      const rule = metric ? await prisma.alertRule.findUnique({ where: { id: parts[1]! }, select: { enabled: true } }) : undefined;
      const reason =
        !instance || instance.status === 'DESTROYED'
          ? 'The instance was destroyed.'
          : !resource || resource.status === 'DELETED'
            ? `${resourceId} no longer exists.`
            : metric && !rule?.enabled
              ? 'The alert rule that opened it was removed or turned off.'
              : null;
      if (!reason) continue;
      await prisma.incident.update({
        where: { id: incident.id },
        data: { status: 'RESOLVED', resolvedAt: new Date(), updates: { create: { status: 'RESOLVED', message: `Resolved automatically: ${reason}` } } },
      });
      platformMetrics.incidentResolved(incident.openedAt);
      await notify(this.ctx, { tenantId: incident.tenantId, event: 'incident.resolved', title: `Resolved: ${incident.title}`, body: reason, link: `/incidents/${incident.id}`, data: { incidentId: incident.id, instanceId } });
      await systemAudit(this.ctx, { tenantId: incident.tenantId, resourceType: 'Incident', resourceId: incident.id, action: 'AUTO_RESOLVE', changes: { reason } });
      resolved++;
    }
    return resolved;
  }

  /**
   * Deletes old records in batches, at most once an hour across all workers. Returns the rows
   * deleted per table, or null when another run already claimed this hour.
   */
  async pruneRecords(now: Date): Promise<Record<string, number> | null> {
    const claimed = await this.ctx.redis.set('housekeeping:prune', now.toISOString(), 'EX', 3600, 'NX');
    if (claimed !== 'OK') return null;
    const { config } = this.ctx;
    const ended = new Date(now.getTime() - 30 * DAY);
    const notifications = new Date(now.getTime() - config.NOTIFICATION_RETENTION_DAYS * DAY);
    const deleted: Record<string, number> = {
      sessions: await this.prune(Prisma.sql`SELECT id FROM "Session" WHERE "expiresAt" < ${ended} OR "revokedAt" < ${ended}`, 'Session'),
      invitations: await this.prune(Prisma.sql`SELECT id FROM "Invitation" WHERE "expiresAt" < ${ended} OR "acceptedAt" < ${ended}`, 'Invitation'),
      notifications: await this.prune(Prisma.sql`SELECT id FROM "Notification" WHERE "createdAt" < ${notifications}`, 'Notification'),
      notificationDeliveries: await this.prune(Prisma.sql`SELECT id FROM "NotificationDelivery" WHERE "createdAt" < ${notifications} AND status <> 'PENDING'`, 'NotificationDelivery'),
      webhookDeliveries: await this.prune(Prisma.sql`SELECT id FROM "WebhookDelivery" WHERE "createdAt" < ${notifications} AND status <> 'PENDING'`, 'WebhookDelivery'),
      deploymentEvents:
        config.DEPLOYMENT_EVENT_RETENTION_DAYS > 0
          ? await this.prune(Prisma.sql`SELECT id FROM "DeploymentEvent" WHERE at < ${new Date(now.getTime() - config.DEPLOYMENT_EVENT_RETENTION_DAYS * DAY)}`, 'DeploymentEvent')
          : 0,
    };
    if (Object.values(deleted).some((n) => n > 0)) this.ctx.logger.info(deleted, 'old records pruned');
    return deleted;
  }

  /** Deletes the rows `select` finds, BATCH at a time. Table names are fixed above, never input. */
  private async prune(select: Prisma.Sql, table: 'Session' | 'Invitation' | 'Notification' | 'NotificationDelivery' | 'WebhookDelivery' | 'DeploymentEvent'): Promise<number> {
    let total = 0;
    for (let i = 0; i < MAX_BATCHES; i++) {
      const n = await this.ctx.prisma.$executeRaw(Prisma.sql`DELETE FROM ${Prisma.raw(`"${table}"`)} WHERE id IN (${select} LIMIT ${BATCH})`);
      total += n;
      if (n < BATCH) break;
    }
    return total;
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
