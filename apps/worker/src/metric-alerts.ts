// SPDX-License-Identifier: AGPL-3.0-only
import type { AlertRule, InstanceResource } from '@orkstage/database';
import { healthToStatus } from '@orkstage/domain';
import { platformMetrics, toCloudTarget } from '@orkstage/runtime';
import { randomUUID } from 'node:crypto';
import { notify, systemAudit, type WorkerContext } from './context.js';

export interface MetricCondition {
  signal: 'metric';
  metric: string;
  resourceTypes?: string[];
  operator: '>' | '>=' | '<' | '<=';
  threshold: number;
  windowMinutes: number;
  statistic?: 'avg' | 'max' | 'min';
}

/** One rule is read from the provider at most this often per instance (provider APIs cost money). */
const EVALUATE_EVERY_MS = 60_000;

export function aggregate(values: number[], statistic: MetricCondition['statistic'] = 'avg'): number {
  if (statistic === 'max') return Math.max(...values);
  if (statistic === 'min') return Math.min(...values);
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function compare(value: number, operator: MetricCondition['operator'], threshold: number): boolean {
  switch (operator) {
    case '>':
      return value > threshold;
    case '>=':
      return value >= threshold;
    case '<':
      return value < threshold;
    default:
      return value <= threshold;
  }
}

/**
 * Metric alert rules (open item 7): a statistic of a metric over a window compared with a
 * threshold. A breach opens one deduplicated incident per rule, instance and resource; when the
 * condition clears and the rule auto resolves, the incident is resolved. After a resolve, the
 * rule's cooldown keeps a flapping metric from reopening it at once.
 */
export class MetricAlerts {
  private readonly lastRun = new Map<string, number>();

  constructor(
    private readonly ctx: WorkerContext,
    private readonly now: () => number = Date.now,
  ) {}

  async evaluate(
    instance: { id: string; tenantId: string; name: string },
    resources: InstanceResource[],
    rules: AlertRule[],
    targets: Map<string, Parameters<typeof toCloudTarget>[0]>,
  ): Promise<void> {
    for (const rule of rules) {
      const cond = rule.condition as unknown as MetricCondition;
      if (!rule.enabled || cond?.signal !== 'metric') continue;
      const runKey = `${rule.id}:${instance.id}`;
      if (this.now() - (this.lastRun.get(runKey) ?? 0) < EVALUATE_EVERY_MS) continue;
      this.lastRun.set(runKey, this.now());
      for (const r of resources) {
        if (cond.resourceTypes?.length && !cond.resourceTypes.includes(r.type)) continue;
        const value = await this.read(r, cond, targets.get(r.targetId));
        if (value === null) continue;
        await this.apply(rule, cond, instance, r, value);
      }
    }
  }

  /** The aggregated value over the window, or null when there is no data to judge. */
  private async read(r: InstanceResource, cond: MetricCondition, target: Parameters<typeof toCloudTarget>[0] | undefined): Promise<number | null> {
    const { registry } = this.ctx;
    if (!target || !registry.has(r.provider)) return null;
    const adapter = registry.get(r.provider);
    if (!adapter.getMetric) return null;
    try {
      const points = await adapter.getMetric(
        { target: toCloudTarget(target), region: r.region, correlationId: `metric-${randomUUID()}` },
        { resourceId: r.resourceId, serviceKind: r.type, capability: r.capability, name: r.name, providerResourceId: r.providerResourceId ?? undefined, outputs: r.outputs as never },
        cond.metric,
        cond.windowMinutes,
      );
      const values = points.map((p) => p.value).filter((v) => Number.isFinite(v));
      return values.length ? aggregate(values, cond.statistic) : null;
    } catch (err) {
      this.ctx.logger.warn({ resourceId: r.resourceId, metric: cond.metric, err: (err as Error).message }, 'metric read failed');
      return null;
    }
  }

  private async apply(rule: AlertRule, cond: MetricCondition, instance: { id: string; tenantId: string; name: string }, r: InstanceResource, value: number) {
    const { prisma } = this.ctx;
    const dedupKey = `metric:${rule.id}:${instance.id}:${r.resourceId}`;
    const breach = compare(value, cond.operator, cond.threshold);
    const open = await prisma.incident.findFirst({ where: { dedupKey, status: { not: 'RESOLVED' } } });
    const shown = Math.round(value * 100) / 100;

    if (!breach) {
      if (open && rule.autoResolve) {
        await prisma.incident.update({
          where: { id: open.id },
          data: { status: 'RESOLVED', resolvedAt: new Date(), updates: { create: { status: 'RESOLVED', message: `Recovered: ${cond.metric} is ${shown} (${rule.name}).` } } },
        });
        platformMetrics.incidentResolved(open.openedAt);
        await notify(this.ctx, { tenantId: instance.tenantId, event: 'incident.resolved', title: `Resolved: ${open.title}`, body: `${cond.metric} is back within ${cond.operator} ${cond.threshold}.`, link: `/incidents/${open.id}`, data: { incidentId: open.id, instanceId: instance.id } });
        await systemAudit(this.ctx, { tenantId: instance.tenantId, resourceType: 'Incident', resourceId: open.id, action: 'AUTO_RESOLVE', changes: { rule: rule.name, value: shown } });
      }
      return;
    }
    if (open || !rule.actions.includes('create_incident')) return;
    const recent = await prisma.incident.findFirst({ where: { dedupKey, resolvedAt: { gte: new Date(this.now() - rule.cooldownSeconds * 1000) } } });
    if (recent) return;

    const incident = await prisma.incident
      .create({
        data: {
          tenantId: instance.tenantId,
          instanceId: instance.id,
          title: `${r.resourceId} ${cond.metric} ${cond.operator} ${cond.threshold} on ${instance.name}`,
          impact: healthToStatus('DEGRADED', r.critical),
          severity: rule.severity,
          source: 'AUTOMATED',
          dedupKey,
          updates: {
            create: {
              status: 'INVESTIGATING',
              message: `Automated: ${cond.metric} ${cond.statistic ?? 'avg'} over ${cond.windowMinutes} min is ${shown}, ${cond.operator} ${cond.threshold} (${rule.name}).`,
            },
          },
        },
      })
      // One open incident per dedup key is enforced by a unique index: a parallel tick may have won.
      .catch((err: { code?: string }) => {
        if (err.code === 'P2002') return null;
        throw err;
      });
    if (!incident) return;
    platformMetrics.incidentOpened('metric');
    if (rule.actions.includes('notify_owners')) {
      await notify(this.ctx, { tenantId: instance.tenantId, event: 'incident.opened', title: incident.title, body: 'A metric crossed its alert threshold and we opened an incident.', link: `/incidents/${incident.id}`, data: { incidentId: incident.id, instanceId: instance.id, severity: incident.severity } });
    }
    await systemAudit(this.ctx, { tenantId: instance.tenantId, resourceType: 'Incident', resourceId: incident.id, action: 'OPEN', changes: { rule: rule.name, resourceId: r.resourceId, value: shown } });
  }
}
