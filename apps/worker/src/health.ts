// SPDX-License-Identifier: AGPL-3.0-only
import type { ResourceOutputs } from '@orkstage/cloud-core';
import type { AlertRule, InstanceResource } from '@orkstage/database';
import { flagsByTenant, healthToStatus, type HealthState } from '@orkstage/domain';
import { platformMetrics, toCloudTarget } from '@orkstage/runtime';
import { randomUUID } from 'node:crypto';
import { notify, systemAudit, type WorkerContext } from './context.js';
import { BackupMonitor } from './backups.js';
import { DomainMonitor } from './domains.js';
import { MetricAlerts } from './metric-alerts.js';
import { instanceHealth, syncStatusComponents } from './status.js';

interface HealthCondition {
  signal: 'health';
  critical?: boolean;
  consecutiveFailures: number;
}

/**
 * Periodic health evaluation (spec §24, §27, §29): checks every active resource, rolls health
 * up to instances and status components, opens deduplicated incidents from data-driven alert
 * rules, and auto-resolves them when health returns. Also records drift (spec §31).
 */
export class HealthMonitor {
  private readonly metricAlerts: MetricAlerts;
  private readonly domains: DomainMonitor;
  private readonly backups: BackupMonitor;

  constructor(private readonly ctx: WorkerContext) {
    this.metricAlerts = new MetricAlerts(ctx);
    this.domains = new DomainMonitor(ctx);
    this.backups = new BackupMonitor(ctx);
  }

  async tick(): Promise<void> {
    const { prisma } = this.ctx;
    const tickStartedAt = new Date();
    const instances = await prisma.instance.findMany({
      where: { status: { in: ['READY', 'DEGRADED'] } },
      include: { resources: { where: { status: 'ACTIVE' } } },
    });
    const rules = await prisma.alertRule.findMany({ where: { enabled: true } });
    const flagsFor = flagsByTenant(await prisma.featureFlag.findMany());
    const targets = new Map((await prisma.cloudTarget.findMany()).map((t) => [t.id, t]));

    for (const instance of instances) {
      for (const r of instance.resources) await this.checkResource(r, targets.get(r.targetId));
      const fresh = await prisma.instanceResource.findMany({ where: { instanceId: instance.id, status: 'ACTIVE' } });
      // A critical service that just turned unhealthy is news, before any incident opens (open item 16).
      for (const r of fresh) {
        const before = instance.resources.find((x) => x.id === r.id);
        if (r.critical && r.health === 'UNHEALTHY' && before && before.health !== 'UNHEALTHY') {
          await notify(this.ctx, {
            tenantId: instance.tenantId,
            event: 'service.unhealthy',
            title: `${r.resourceId} is unhealthy on ${instance.name}`,
            body: r.healthMessage ? `The last health check said: ${r.healthMessage.slice(0, 200)}` : 'The last health check failed.',
            link: `/instances/${instance.id}`,
            data: { instanceId: instance.id, resourceId: r.resourceId },
          });
        }
      }
      const health = instanceHealth(fresh);
      const nextStatus = health === 'UNHEALTHY' || health === 'DEGRADED' ? 'DEGRADED' : health === 'HEALTHY' ? 'READY' : instance.status;
      if (health !== instance.health || nextStatus !== instance.status) {
        await prisma.$transaction([
          prisma.instance.update({ where: { id: instance.id }, data: { health, status: nextStatus } }),
          ...(nextStatus !== instance.status
            ? [prisma.instanceTransition.create({ data: { instanceId: instance.id, tenantId: instance.tenantId, from: instance.status, to: nextStatus, reason: `health ${health}` } })]
            : []),
        ]);
        if (nextStatus === 'DEGRADED' && instance.status !== 'DEGRADED') {
          await notify(this.ctx, { tenantId: instance.tenantId, event: 'instance.degraded', title: `${instance.name} is degraded`, body: 'One or more components are not healthy. We are tracking it on your status page.', link: `/instances/${instance.id}`, data: { instanceId: instance.id, health } });
        }
      }
      const inMaintenance = await syncStatusComponents(this.ctx, instance.id, instance.tenantId);
      // Checks taken during planned work count neither way in uptime: they are kept as MAINTENANCE.
      if (inMaintenance.size > 0) {
        await prisma.healthCheckResult.updateMany({
          where: { instanceId: instance.id, resourceId: { in: [...inMaintenance] }, checkedAt: { gte: tickStartedAt } },
          data: { state: 'MAINTENANCE' },
        });
      }
      // With AUTOMATED_INCIDENTS off, rules still notify and resolve what is open, but open nothing.
      const automated = flagsFor(instance.tenantId).AUTOMATED_INCIDENTS;
      const scoped = rules
        .filter((rule) => !rule.tenantId || rule.tenantId === instance.tenantId)
        .map((rule) => (automated ? rule : { ...rule, actions: rule.actions.filter((a) => a !== 'create_incident') }));
      await this.evaluateAlerts(instance, fresh, scoped, inMaintenance);
      await this.metricAlerts.evaluate(instance, fresh.filter((r) => !inMaintenance.has(r.resourceId)), scoped, targets);
    }
    await this.announceMaintenance();
    await this.domains.tick(targets);
    await this.backups.tick(targets);
  }

  /** Tells the tenant and the status page subscribers when a maintenance window starts and ends. */
  private async announceMaintenance(now = new Date()) {
    const { prisma } = this.ctx;
    const starting = await prisma.maintenanceWindow.findMany({ where: { startedAt: null, startsAt: { lte: now }, endsAt: { gt: now } }, take: 50 });
    for (const w of starting) {
      // Claimed with a conditional update, so a second worker does not announce it again.
      const { count } = await prisma.maintenanceWindow.updateMany({ where: { id: w.id, startedAt: null }, data: { startedAt: now } });
      if (count === 0) continue;
      await notify(this.ctx, { tenantId: w.tenantId, event: 'maintenance.started', title: `Maintenance started: ${w.title}`, body: `Planned until ${w.endsAt.toUTCString()}.${w.message ? ` ${w.message}` : ''}`, link: `/status/${w.tenantId}`, data: { maintenanceId: w.id } });
    }
    const ending = await prisma.maintenanceWindow.findMany({ where: { completedAt: null, startedAt: { not: null }, endsAt: { lte: now } }, take: 50 });
    for (const w of ending) {
      const { count } = await prisma.maintenanceWindow.updateMany({ where: { id: w.id, completedAt: null }, data: { completedAt: now } });
      if (count === 0) continue;
      await notify(this.ctx, { tenantId: w.tenantId, event: 'maintenance.completed', title: `Maintenance completed: ${w.title}`, body: 'The planned work is over.', link: `/status/${w.tenantId}`, data: { maintenanceId: w.id } });
    }
  }

  private async checkResource(r: InstanceResource, targetRow: Parameters<typeof toCloudTarget>[0] | undefined) {
    const { prisma, registry } = this.ctx;
    if (!targetRow || !registry.has(r.provider)) return;
    const adapter = registry.get(r.provider);
    const pctx = { target: toCloudTarget(targetRow), region: r.region, correlationId: `health-${randomUUID()}` };
    const ident = {
      resourceId: r.resourceId,
      serviceKind: r.type,
      capability: r.capability,
      name: r.name,
      providerResourceId: r.providerResourceId ?? undefined,
      // Recorded outputs spare adapters a state read on every health cycle.
      outputs: (r.outputs ?? undefined) as ResourceOutputs | undefined,
    };

    let state: HealthState = 'UNKNOWN';
    let message: string | undefined;
    let latencyMs: number | undefined;
    try {
      const h = await adapter.checkHealth(pctx, ident);
      ({ state, message, latencyMs } = h);
    } catch (err) {
      message = `Health check error: ${(err as Error).message.slice(0, 200)}`;
    }
    platformMetrics.healthCheck(r.provider, state);

    let drift = r.drift;
    let driftChecked = true;
    try {
      let actual = await adapter.getResource(pctx, ident);
      // One read saying "gone" is not enough (a state read can fail transiently): confirm it.
      if (!actual.exists) actual = await adapter.getResource(pctx, ident);
      // A missing resource is drift. Adapters that observe the running spec answer here; for the
      // others (real providers) the scheduled drift scan owns the value, so keep what it found.
      if (!actual.exists) drift = 'DRIFT_DETECTED';
      else if (actual.observedSpecHash !== undefined) drift = actual.observedSpecHash !== r.idempotencyKey ? 'DRIFT_DETECTED' : 'IN_SYNC';
      else driftChecked = false;
    } catch {
      driftChecked = false;
    }
    if (drift === 'DRIFT_DETECTED' && r.drift !== 'DRIFT_DETECTED') {
      await systemAudit(this.ctx, { tenantId: r.tenantId, resourceType: 'InstanceResource', resourceId: `${r.instanceId}/${r.resourceId}`, action: 'DRIFT_DETECTED' });
    }

    await prisma.instanceResource.update({
      where: { id: r.id },
      data: {
        health: state,
        healthMessage: message,
        healthCheckedAt: new Date(),
        consecutiveHealthFailures: state === 'UNHEALTHY' ? r.consecutiveHealthFailures + 1 : 0,
        drift,
        ...(driftChecked ? { driftCheckedAt: new Date() } : {}),
      },
    });
    await prisma.healthCheckResult.create({ data: { tenantId: r.tenantId, instanceId: r.instanceId, resourceId: r.resourceId, state, latencyMs, message } });
  }

  private async evaluateAlerts(instance: { id: string; tenantId: string; name: string }, resources: InstanceResource[], rules: AlertRule[], inMaintenance: Set<string>) {
    const { prisma } = this.ctx;
    for (const r of resources) {
      const dedupKey = `health:${instance.id}:${r.resourceId}`;
      const open = await prisma.incident.findFirst({ where: { dedupKey, status: { not: 'RESOLVED' } } });

      // The rule that opened the incident decides: with auto resolve off, a person resolves it.
      // Incidents from before rules were recorded, or whose rule is gone, resolve on recovery.
      const keepOpen = open?.ruleId ? rules.some((rule) => rule.id === open.ruleId && !rule.autoResolve) : false;
      if (r.health === 'HEALTHY' && open?.source === 'AUTOMATED' && !keepOpen) {
        await prisma.incident.update({
          where: { id: open.id },
          data: { status: 'RESOLVED', resolvedAt: new Date(), updates: { create: { status: 'RESOLVED', message: `Health restored for ${r.resourceId}.` } } },
        });
        platformMetrics.incidentResolved(open.openedAt);
        await notify(this.ctx, { tenantId: instance.tenantId, event: 'incident.resolved', title: `Resolved: ${open.title}`, body: 'The affected component is healthy again.', link: `/incidents/${open.id}`, data: { incidentId: open.id, instanceId: instance.id } });
        await systemAudit(this.ctx, { tenantId: instance.tenantId, resourceType: 'Incident', resourceId: open.id, action: 'AUTO_RESOLVE' });
        continue;
      }
      if (r.health !== 'UNHEALTHY' || open) continue; // dedup: one open incident per resource
      if (inMaintenance.has(r.resourceId)) continue; // planned work opens no incidents

      const rule = rules.find((rule) => {
        const c = rule.condition as unknown as HealthCondition;
        return c.signal === 'health' && (c.critical === undefined || c.critical === r.critical) && r.consecutiveHealthFailures >= c.consecutiveFailures;
      });
      if (!rule?.actions.includes('create_incident')) continue;

      // Cooldown: avoid flapping incidents right after one was resolved.
      const recent = await prisma.incident.findFirst({ where: { dedupKey, resolvedAt: { gte: new Date(Date.now() - rule.cooldownSeconds * 1000) } } });
      if (recent) continue;

      const component = r.type === 'database.postgresql' ? 'Database' : r.type === 'compute.container-service' ? (r.critical ? 'API' : 'Workers') : r.resourceId;
      const incident = await prisma.incident
        .create({
        data: {
          tenantId: instance.tenantId,
          instanceId: instance.id,
          title: `${component} unavailable on ${instance.name}`,
          impact: healthToStatus('UNHEALTHY', r.critical),
          severity: rule.severity,
          source: 'AUTOMATED',
          dedupKey,
          ruleId: rule.id,
          updates: { create: { status: 'INVESTIGATING', message: `Automated: ${r.consecutiveHealthFailures} consecutive failed health checks (${rule.name}).` } },
        },
      })
        // One open incident per dedup key is enforced by a unique index: if another tick won the
        // race, its incident stands and this one is dropped.
        .catch((err: { code?: string }) => {
          if (err.code === 'P2002') return null;
          throw err;
        });
      if (!incident) continue;
      platformMetrics.incidentOpened('automated');
      if (rule.actions.includes('notify_owners')) {
        await notify(this.ctx, { tenantId: instance.tenantId, event: 'incident.opened', title: incident.title, body: 'We detected a problem and opened an incident. Follow updates on your status page.', link: `/incidents/${incident.id}`, data: { incidentId: incident.id, instanceId: instance.id, severity: incident.severity } });
      }
      await systemAudit(this.ctx, { tenantId: instance.tenantId, resourceType: 'Incident', resourceId: incident.id, action: 'OPEN', changes: { rule: rule.name, resourceId: r.resourceId } });
    }
  }
}
