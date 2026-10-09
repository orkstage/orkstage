import { listQuerySchema, type AuditEventDto, type ListQuery, type NotificationDto, type OverviewDto, type StatusPageDto } from '@orkstage/contracts';
import type { AuditEvent, PrismaClient } from '@orkstage/database';
import { worstStatus, type StatusState } from '@orkstage/domain';
import { Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Redis } from 'ioredis';
import { authorize, CurrentPrincipal, isPlatformStaff, Public, Scope } from '../common/auth.js';
import { AppError, forbidden, notFound } from '../common/errors.js';
import { iso, page } from '../common/pagination.js';
import { ZodQuery } from '../common/validation.js';
import { PRISMA, REDIS } from '../infra/infra.module.js';
import type { RequestPrincipal } from '../types.js';
import { toIncidentDto } from './incidents.controller.js';

function toAuditDto(e: AuditEvent): AuditEventDto {
  return {
    id: String(e.id),
    at: e.at.toISOString(),
    actorType: e.actorType,
    actorLabel: e.actorLabel,
    tenantId: e.tenantId,
    resourceType: e.resourceType,
    resourceId: e.resourceId,
    action: e.action,
    result: e.result,
    correlationId: e.correlationId,
    changes: (e.changes ?? null) as Record<string, unknown> | null,
  };
}

@ApiTags('operations')
@Controller()
export class OpsController {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  @Public()
  @SkipThrottle()
  @Get('healthz')
  healthz() {
    return { status: 'ok' };
  }

  @Public()
  @SkipThrottle()
  @Get('readyz')
  async readyz() {
    try {
      await Promise.all([this.prisma.$queryRaw`SELECT 1`, this.redis.ping()]);
      return { status: 'ready' };
    } catch {
      throw new AppError(503, 'NOT_READY', 'Dependencies are not reachable.');
    }
  }

  /** Platform dashboard (spec §42). Platform staff only. */
  @Get('overview')
  async overview(@CurrentPrincipal() p: RequestPrincipal): Promise<OverviewDto> {
    if (!isPlatformStaff(p)) throw forbidden();
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [tenants, byStatus, unhealthy, openIncidents, deployments, failed, targets, resources, audit, lastCosts] = await Promise.all([
      this.prisma.tenant.count(),
      this.prisma.instance.groupBy({ by: ['status'], _count: true, where: { status: { not: 'DESTROYED' } } }),
      this.prisma.instanceResource.count({ where: { status: 'ACTIVE', health: { in: ['UNHEALTHY', 'DEGRADED'] } } }),
      this.prisma.incident.count({ where: { status: { not: 'RESOLVED' } } }),
      this.prisma.deployment.count({ where: { queuedAt: { gte: since } } }),
      this.prisma.deployment.count({ where: { queuedAt: { gte: since }, status: { in: ['FAILED', 'PARTIALLY_FAILED'] } } }),
      this.prisma.cloudTarget.findMany({ select: { id: true, name: true, provider: true, health: true }, orderBy: { createdAt: 'asc' } }),
      this.prisma.instanceResource.groupBy({ by: ['provider', 'simulatedProvider'], _count: true, where: { status: 'ACTIVE' } }),
      this.prisma.auditEvent.findMany({ orderBy: { id: 'desc' }, take: 10 }),
      this.prisma.$queryRaw<{ total: number | null }[]>`
        SELECT SUM((d.cost->>'total')::numeric)::float AS total FROM (
          SELECT DISTINCT ON ("instanceId") cost FROM "Deployment"
          WHERE kind = 'APPLY' AND status IN ('SUCCEEDED', 'PARTIALLY_FAILED')
            AND "instanceId" IN (SELECT id FROM "Instance" WHERE status NOT IN ('DESTROYED'))
          ORDER BY "instanceId", "queuedAt" DESC
        ) d`,
    ]);
    const providerDistribution: Record<string, number> = {};
    for (const r of resources) {
      const key = r.simulatedProvider ? `${r.simulatedProvider} (simulated)` : r.provider;
      providerDistribution[key] = (providerDistribution[key] ?? 0) + r._count;
    }
    return {
      tenants,
      instances: byStatus.reduce((s, g) => s + g._count, 0),
      instancesByStatus: Object.fromEntries(byStatus.map((g) => [g.status, g._count])),
      unhealthyResources: unhealthy,
      openIncidents,
      deployments24h: { total: deployments, failed },
      targets,
      providerDistribution,
      estimatedMonthlyCost: Math.round((lastCosts[0]?.total ?? 0) * 100) / 100,
      recentAudit: audit.map(toAuditDto),
    };
  }

  /** Time series for the platform dashboard charts. Platform staff only. */
  @Get('overview/trends')
  async trends(@CurrentPrincipal() p: RequestPrincipal, @Query('days') daysParam?: string) {
    if (!isPlatformStaff(p)) throw forbidden();
    const days = Math.min(90, Math.max(1, Number(daysParam) || 14));
    const since = new Date(Date.now() - (days - 1) * 86_400_000);
    since.setUTCHours(0, 0, 0, 0);

    const [deployments, opened, resolved, health, costRows] = await Promise.all([
      this.prisma.$queryRaw<{ day: string; status: string; n: number }[]>`
        SELECT to_char(date_trunc('day', "queuedAt" AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day, status::text AS status, count(*)::int AS n
        FROM "Deployment" WHERE "queuedAt" >= ${since} GROUP BY 1, 2`,
      this.prisma.$queryRaw<{ day: string; n: number }[]>`
        SELECT to_char(date_trunc('day', "openedAt" AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day, count(*)::int AS n
        FROM "Incident" WHERE "openedAt" >= ${since} GROUP BY 1`,
      this.prisma.$queryRaw<{ day: string; n: number }[]>`
        SELECT to_char(date_trunc('day', "resolvedAt" AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day, count(*)::int AS n
        FROM "Incident" WHERE "resolvedAt" >= ${since} GROUP BY 1`,
      this.prisma.instanceResource.groupBy({ by: ['health'], _count: true, where: { status: 'ACTIVE' } }),
      // Latest successful apply per live instance; its cost snapshot has per-resource lines.
      this.prisma.$queryRaw<{ cost: { lines?: { provider: string; monthly: number | null }[] } }[]>`
        SELECT DISTINCT ON ("instanceId") cost FROM "Deployment"
        WHERE kind = 'APPLY' AND status IN ('SUCCEEDED', 'PARTIALLY_FAILED')
          AND "instanceId" IN (SELECT id FROM "Instance" WHERE status <> 'DESTROYED')
        ORDER BY "instanceId", "queuedAt" DESC`,
    ]);

    const dayKeys = Array.from({ length: days }, (_, i) => new Date(since.getTime() + i * 86_400_000).toISOString().slice(0, 10));
    const count = (rows: { day: string; n: number }[], day: string) => rows.find((r) => r.day === day)?.n ?? 0;
    const costByProvider = new Map<string, number>();
    for (const row of costRows) {
      for (const line of row.cost?.lines ?? []) {
        if (line.monthly !== null) costByProvider.set(line.provider, (costByProvider.get(line.provider) ?? 0) + line.monthly);
      }
    }
    const resourcesByHealth = { HEALTHY: 0, DEGRADED: 0, UNHEALTHY: 0, UNKNOWN: 0, MAINTENANCE: 0 };
    for (const h of health) resourcesByHealth[h.health] = h._count;

    return {
      deploymentsByDay: dayKeys.map((day) => {
        const rows = deployments.filter((d) => d.day === day);
        const of = (statuses: string[]) => rows.filter((r) => statuses.includes(r.status)).reduce((s, r) => s + r.n, 0);
        return { day, succeeded: of(['SUCCEEDED']), failed: of(['FAILED', 'PARTIALLY_FAILED']), other: of(['QUEUED', 'RUNNING', 'AWAITING_APPROVAL', 'CANCELLED']) };
      }),
      incidentsByDay: dayKeys.map((day) => ({ day, opened: count(opened, day), resolved: count(resolved, day) })),
      costByProvider: [...costByProvider].map(([provider, monthly]) => ({ provider, monthly: Math.round(monthly * 100) / 100 })).sort((a, b) => b.monthly - a.monthly),
      resourcesByHealth,
    };
  }

  /** Private, tenant-scoped status page (spec §26, §52). Never includes other tenants' data. */
  @Scope('instances:read')
  @Get('status/:tenantId')
  async status(@CurrentPrincipal() p: RequestPrincipal, @Param('tenantId', ParseUUIDPipe) tenantId: string): Promise<StatusPageDto> {
    authorize(p, 'read', 'StatusPage', { tenantId });
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw notFound('Tenant');
    const [instances, open, recent, deployments] = await Promise.all([
      this.prisma.instance.findMany({
        where: { tenantId, status: { not: 'DESTROYED' } },
        include: { components: { orderBy: { position: 'asc' } } },
        orderBy: { name: 'asc' },
      }),
      this.prisma.incident.findMany({ where: { tenantId, status: { not: 'RESOLVED' } }, include: { updates: { orderBy: { at: 'desc' }, take: 1 } }, orderBy: { openedAt: 'desc' } }),
      this.prisma.incident.findMany({ where: { tenantId, status: 'RESOLVED' }, orderBy: { resolvedAt: 'desc' }, take: 5 }),
      this.prisma.deployment.findMany({ where: { tenantId, finishedAt: { not: null } }, orderBy: { finishedAt: 'desc' }, take: 8, include: { instance: { select: { name: true } } } }),
    ]);
    const targetIds = new Set(instances.flatMap((i) => Object.values(i.bindings as Record<string, { targetId: string }>).map((b) => b.targetId)));
    const mockTargets = new Set((await this.prisma.cloudTarget.findMany({ where: { id: { in: [...targetIds] }, provider: 'mock' }, select: { id: true } })).map((t) => t.id));

    const instanceStatus = (components: { status: StatusState }[], status: string): StatusState =>
      components.length > 0 ? worstStatus(components.map((c) => c.status)) : status === 'READY' ? 'OPERATIONAL' : 'UNKNOWN';
    const view = instances.map((i) => ({
      id: i.id,
      name: i.name,
      status: instanceStatus(i.components, i.status),
      simulated: Object.values(i.bindings as Record<string, { targetId: string }>).every((b) => mockTargets.has(b.targetId)),
      components: i.components.map((c) => ({ id: c.id, name: c.name, status: c.status })),
    }));
    const activity = [
      ...deployments.map((d) => ({
        at: d.finishedAt!.toISOString(),
        kind: 'deployment',
        message: `${d.kind === 'APPLY' ? 'Deployment' : 'Destroy'} of ${d.instance.name} ${d.status === 'SUCCEEDED' ? 'completed' : d.status.toLowerCase().replace('_', ' ')}`,
      })),
      ...recent.map((i) => ({ at: (i.resolvedAt ?? i.openedAt).toISOString(), kind: 'incident', message: `Resolved: ${i.title}` })),
    ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 10);

    return {
      tenant: { id: tenant.id, name: tenant.name },
      overall: worstStatus(view.map((v) => v.status as StatusState)),
      instances: view,
      openIncidents: open.map((i) => toIncidentDto(i)),
      recentIncidents: recent.map((i) => toIncidentDto(i)),
      recentActivity: activity,
    };
  }

  @Get('notifications')
  async notifications(@CurrentPrincipal() p: RequestPrincipal): Promise<NotificationDto[]> {
    const rows = await this.prisma.notification.findMany({ where: { userId: p.userId }, orderBy: { createdAt: 'desc' }, take: 50 });
    return rows.map((n) => ({ id: n.id, event: n.event, title: n.title, body: n.body, link: n.link, readAt: iso(n.readAt), createdAt: n.createdAt.toISOString() }));
  }

  @Post('notifications/:id/read')
  @HttpCode(204)
  async markRead(@CurrentPrincipal() p: RequestPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    await this.prisma.notification.updateMany({ where: { id, userId: p.userId, readAt: null }, data: { readAt: new Date() } });
  }

  @Scope('audit:read')
  @Get('audit')
  async audit(@CurrentPrincipal() p: RequestPrincipal, @ZodQuery(listQuerySchema) q: ListQuery) {
    if (q.tenantId) authorize(p, 'read', 'Audit', { tenantId: q.tenantId });
    else if (!isPlatformStaff(p)) throw forbidden('Choose a tenant to view its audit log.');
    const rows = await this.prisma.auditEvent.findMany({
      where: q.tenantId ? { tenantId: q.tenantId } : {},
      orderBy: { id: 'desc' },
      take: q.limit + 1,
      ...(q.cursor && /^\d+$/.test(q.cursor) ? { cursor: { id: BigInt(q.cursor) }, skip: 1 } : {}),
    });
    return page(rows, q.limit, toAuditDto);
  }
}
