// SPDX-License-Identifier: AGPL-3.0-only
import type { CustomerOverviewDto } from '@orkstage/contracts';
import type { PrismaClient } from '@orkstage/database';
import { uptimeDays, uptimeOf, worstStatus, type StatusState, type UptimeRow } from '@orkstage/domain';
import { Controller, Get, Inject, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { authorize, CurrentPrincipal, Scope } from '../common/auth.js';
import { notFound } from '../common/errors.js';
import { FeatureFlagsService } from '../common/feature-flags.service.js';
import { PRISMA } from '../infra/infra.module.js';
import type { RequestPrincipal } from '../types.js';
import { toIncidentDto } from './incidents.controller.js';

const UPTIME_DAYS = 30;
const RUNNING = ['QUEUED', 'RUNNING', 'AWAITING_APPROVAL'];

const costOf = (cost: unknown): number | null => {
  const total = (cost as { total?: unknown } | null)?.total;
  return typeof total === 'number' ? Math.round(total * 100) / 100 : null;
};

/**
 * The customer dashboard (spec §42, open item 11): health, deployment state, components with
 * uptime, open incidents and recent activity of every instance of a tenant. A fixed number of
 * queries whatever the number of instances; uptime comes from one grouped query over the health
 * check history.
 */
@ApiTags('operations')
@Controller()
export class CustomerOverviewController {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly flags: FeatureFlagsService,
  ) {}

  @Scope('instances:read')
  @Get('tenants/:tenantId/overview')
  async overview(@CurrentPrincipal() p: RequestPrincipal, @Param('tenantId', ParseUUIDPipe) tenantId: string): Promise<CustomerOverviewDto> {
    authorize(p, 'read', 'Instance', { tenantId });
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true, name: true } });
    if (!tenant) throw notFound('Tenant');
    const costs = (await this.flags.forTenant(tenantId)).COST_ESTIMATION;
    const days = uptimeDays(UPTIME_DAYS);
    const since = new Date(`${days[0]}T00:00:00Z`);

    const [instances, latest, applied, open, deployments, incidents, history, mockTargets] = await Promise.all([
      this.prisma.instance.findMany({
        where: { tenantId, status: { not: 'DESTROYED' } },
        include: { components: { orderBy: { position: 'asc' } } },
        orderBy: { name: 'asc' },
      }),
      this.prisma.deployment.findMany({ where: { tenantId }, orderBy: [{ instanceId: 'asc' }, { queuedAt: 'desc' }], distinct: ['instanceId'] }),
      this.prisma.deployment.findMany({
        where: { tenantId, kind: 'APPLY', status: { in: ['SUCCEEDED', 'PARTIALLY_FAILED'] } },
        orderBy: [{ instanceId: 'asc' }, { queuedAt: 'desc' }],
        distinct: ['instanceId'],
        select: { instanceId: true, cost: true },
      }),
      this.prisma.incident.findMany({ where: { tenantId, status: { not: 'RESOLVED' } }, include: { updates: { orderBy: { at: 'desc' }, take: 1 } }, orderBy: { openedAt: 'desc' } }),
      this.prisma.deployment.findMany({ where: { tenantId, finishedAt: { not: null } }, orderBy: { finishedAt: 'desc' }, take: 8, include: { instance: { select: { name: true } } } }),
      this.prisma.incident.findMany({ where: { tenantId }, orderBy: { openedAt: 'desc' }, take: 8 }),
      this.prisma.$queryRaw<(UptimeRow & { instanceId: string })[]>`
        SELECT "instanceId", "resourceId", to_char("checkedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
          (count(*) FILTER (WHERE state IN ('HEALTHY', 'DEGRADED')))::int AS up,
          (count(*) FILTER (WHERE state IN ('HEALTHY', 'DEGRADED', 'UNHEALTHY')))::int AS total
        FROM "HealthCheckResult"
        WHERE "tenantId" = ${tenantId}::uuid AND "checkedAt" >= ${since}
        GROUP BY 1, 2, 3`,
      this.prisma.cloudTarget.findMany({ where: { provider: 'mock' }, select: { id: true } }),
    ]);
    const mock = new Set(mockTargets.map((t) => t.id));
    const lastBy = new Map(latest.map((d) => [d.instanceId, d]));
    const costBy = new Map(applied.map((d) => [d.instanceId, costOf(d.cost)]));

    const view = instances.map((i) => {
      const rows = history.filter((h) => h.instanceId === i.id);
      const shown = i.components.filter((c) => !c.hidden).sort((a, b) => (a.sortOrder ?? 1000 + a.position) - (b.sortOrder ?? 1000 + b.position));
      const last = lastBy.get(i.id);
      const bindings = Object.values(i.bindings as Record<string, { targetId: string }>);
      return {
        id: i.id,
        name: i.name,
        environment: i.environment,
        status: i.status,
        health: i.health,
        simulated: bindings.length > 0 && bindings.every((b) => mock.has(b.targetId)),
        lastDeployment: last ? { id: last.id, kind: last.kind, status: last.status, at: (last.finishedAt ?? last.queuedAt).toISOString() } : null,
        estimatedMonthlyCost: costs ? (costBy.get(i.id) ?? null) : null,
        uptime30d: uptimeOf(rows, [...new Set(rows.map((r) => r.resourceId))], days).overall,
        components: shown.map((c) => {
          const u = uptimeOf(rows, c.resourceIds, days);
          return { name: c.label ?? c.name, status: c.status, uptime30d: u.overall, days: u.days };
        }),
      };
    });

    const activity = [
      ...deployments.map((d) => ({
        at: d.finishedAt!.toISOString(),
        kind: 'deployment' as const,
        message: `${d.kind === 'APPLY' ? 'Deployment' : 'Destroy'} of ${d.instance.name} ${d.status === 'SUCCEEDED' ? 'completed' : d.status.toLowerCase().replace('_', ' ')}`,
        link: `/deployments/${d.id}`,
      })),
      ...incidents.map((i) => ({
        at: (i.resolvedAt ?? i.openedAt).toISOString(),
        kind: 'incident' as const,
        message: `${i.resolvedAt ? 'Resolved' : 'Opened'}: ${i.title}`,
        link: `/incidents/${i.id}`,
      })),
    ]
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, 10);

    const operational = (v: (typeof view)[number]) =>
      v.components.length > 0 ? worstStatus(v.components.map((c) => c.status as StatusState)) === 'OPERATIONAL' : v.health === 'HEALTHY';
    return {
      tenant,
      totals: {
        instances: view.length,
        healthy: view.filter(operational).length,
        deploying: view.filter((v) => v.lastDeployment && RUNNING.includes(v.lastDeployment.status)).length,
        openIncidents: open.length,
        estimatedMonthlyCost: costs ? Math.round(view.reduce((s, v) => s + (v.estimatedMonthlyCost ?? 0), 0) * 100) / 100 : null,
      },
      instances: view,
      openIncidents: open.map((i) => toIncidentDto(i)),
      recentActivity: activity,
    };
  }
}
