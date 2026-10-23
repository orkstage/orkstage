// SPDX-License-Identifier: AGPL-3.0-only
import {
  createMaintenanceSchema,
  subscribeStatusSchema,
  updateMaintenanceSchema,
  updateStatusComponentSchema,
  updateStatusPageSchema,
  type MaintenanceDto,
  type PublicIncidentDto,
  type PublicStatusDto,
  type StatusPageDto,
  type StatusPageSettingsDto,
} from '@orkstage/contracts';
import type { Incident, IncidentUpdate, MaintenanceWindow, PrismaClient, StatusPage } from '@orkstage/database';
import { maintenanceState, publicIncidentTitle, publicIncidentUpdate, sha256, worstStatus, type StatusState } from '@orkstage/domain';
import { verifyUnsubscribeToken, type PlatformConfig } from '@orkstage/runtime';
import { Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { randomBytes } from 'node:crypto';
import type { z } from 'zod';
import { AuditService } from '../common/audit.service.js';
import { authorize, CorrelationId, CurrentPrincipal, isPlatformStaff, Public, Scope } from '../common/auth.js';
import { AppError, conflict, notFound } from '../common/errors.js';
import { ApiZodBody, ZodBody } from '../common/validation.js';
import { CONFIG, PRISMA, Queues } from '../infra/infra.module.js';
import type { RequestPrincipal } from '../types.js';
import { toIncidentDto } from './incidents.controller.js';

/** Resolved incidents the public page lists. */
const PUBLIC_HISTORY_DAYS = 14;

type InstanceWithComponents = { id: string; name: string; status: string; components: { id: string; name: string; status: StatusState; label: string | null; hidden: boolean; sortOrder: number | null; position: number }[] };

/** Components as the page shows them: hidden ones left out, the tenant's labels and order first. */
function shownComponents(i: InstanceWithComponents) {
  return i.components
    .filter((c) => !c.hidden)
    .sort((a, b) => (a.sortOrder ?? 1000 + a.position) - (b.sortOrder ?? 1000 + b.position))
    .map((c) => ({ id: c.id, name: c.label ?? c.name, status: c.status }));
}

function instanceStatus(components: { status: StatusState }[], status: string): StatusState {
  return components.length > 0 ? worstStatus(components.map((c) => c.status)) : status === 'READY' ? 'OPERATIONAL' : 'UNKNOWN';
}

function toMaintenanceDto(w: MaintenanceWindow, instanceName: string | null, now = new Date()): MaintenanceDto {
  return {
    id: w.id,
    tenantId: w.tenantId,
    instanceId: w.instanceId,
    instanceName,
    title: w.title,
    message: w.message,
    componentNames: w.componentNames,
    startsAt: w.startsAt.toISOString(),
    endsAt: w.endsAt.toISOString(),
    state: maintenanceState(w, now),
  };
}

function toPublicIncident(i: Incident & { updates: IncidentUpdate[] }, instanceName: string | null): PublicIncidentDto {
  return {
    id: i.id,
    title: publicIncidentTitle(i, instanceName),
    status: i.status,
    impact: i.impact,
    openedAt: i.openedAt.toISOString(),
    resolvedAt: i.resolvedAt?.toISOString() ?? null,
    updates: i.updates.map((u) => ({ status: u.status, message: publicIncidentUpdate(u), at: u.at.toISOString() })),
  };
}

const newToken = () => randomBytes(24).toString('base64url');

/**
 * Status pages (spec §26, §52, open item 8). Each tenant has one: members read it in the console,
 * owners and admins choose who sees it (owners and admins only, every member, or also the public
 * at `/s/<slug>`), rename, hide and order its components, and schedule maintenance. Anyone who
 * can read it can subscribe to email updates. The public view carries names and states only.
 */
@ApiTags('status')
@Controller()
export class StatusPagesController {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(CONFIG) private readonly config: PlatformConfig,
    private readonly queues: Queues,
    private readonly audit: AuditService,
  ) {}

  /** The status page of a tenant, as its members see it. */
  @Scope('instances:read')
  @Get('status/:tenantId')
  async status(@CurrentPrincipal() p: RequestPrincipal, @Param('tenantId', ParseUUIDPipe) tenantId: string): Promise<StatusPageDto> {
    authorize(p, 'read', 'StatusPage', { tenantId });
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId }, include: { statusPage: true } });
    if (!tenant) throw notFound('Tenant');
    const settings = tenant.statusPage;
    // A private page is for platform staff and the tenant's owners and admins.
    if (settings?.visibility === 'PRIVATE' && !this.may(p, 'update', tenantId)) throw notFound('Status page');

    const now = new Date();
    const [instances, open, recent, deployments, windows, subscription] = await Promise.all([
      this.prisma.instance.findMany({
        where: { tenantId, status: { not: 'DESTROYED' } },
        include: { components: { orderBy: { position: 'asc' } } },
        orderBy: { name: 'asc' },
      }),
      this.prisma.incident.findMany({ where: { tenantId, status: { not: 'RESOLVED' } }, include: { updates: { orderBy: { at: 'desc' }, take: 1 } }, orderBy: { openedAt: 'desc' } }),
      this.prisma.incident.findMany({ where: { tenantId, status: 'RESOLVED' }, orderBy: { resolvedAt: 'desc' }, take: 5 }),
      this.prisma.deployment.findMany({ where: { tenantId, finishedAt: { not: null } }, orderBy: { finishedAt: 'desc' }, take: 8, include: { instance: { select: { name: true } } } }),
      this.prisma.maintenanceWindow.findMany({ where: { tenantId, endsAt: { gt: now } }, orderBy: { startsAt: 'asc' }, take: 20 }),
      settings && !p.apiKey ? this.prisma.statusSubscription.findFirst({ where: { statusPageId: settings.id, email: p.email.toLowerCase(), confirmedAt: { not: null } } }) : null,
    ]);
    const targetIds = new Set(instances.flatMap((i) => Object.values(i.bindings as Record<string, { targetId: string }>).map((b) => b.targetId)));
    const mockTargets = new Set((await this.prisma.cloudTarget.findMany({ where: { id: { in: [...targetIds] }, provider: 'mock' }, select: { id: true } })).map((t) => t.id));
    const names = new Map(instances.map((i) => [i.id, i.name]));

    const view = instances.map((i) => {
      const components = shownComponents(i);
      return {
        id: i.id,
        name: i.name,
        status: instanceStatus(components, i.status),
        simulated: Object.values(i.bindings as Record<string, { targetId: string }>).every((b) => mockTargets.has(b.targetId)),
        components,
      };
    });
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
      overall: worstStatus(view.map((v) => v.status)),
      instances: view,
      openIncidents: open.map((i) => toIncidentDto(i)),
      recentIncidents: recent.map((i) => toIncidentDto(i)),
      recentActivity: activity,
      maintenance: windows.map((w) => toMaintenanceDto(w, w.instanceId ? (names.get(w.instanceId) ?? null) : null, now)),
      page: { visibility: settings?.visibility ?? 'CUSTOMER_ONLY', slug: settings?.slug ?? null, title: settings?.title ?? null, description: settings?.description ?? null },
      subscribed: !!subscription,
    };
  }

  @Scope('instances:read')
  @Get('status-pages/:tenantId/settings')
  async settings(@CurrentPrincipal() p: RequestPrincipal, @Param('tenantId', ParseUUIDPipe) tenantId: string): Promise<StatusPageSettingsDto> {
    authorize(p, 'update', 'StatusPage', { tenantId });
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId }, include: { statusPage: true } });
    if (!tenant) throw notFound('Tenant');
    const instances = await this.prisma.instance.findMany({
      where: { tenantId, status: { not: 'DESTROYED' } },
      include: { components: { orderBy: { position: 'asc' } } },
      orderBy: { name: 'asc' },
    });
    const s = tenant.statusPage;
    const confirmedSubscribers = s ? await this.prisma.statusSubscription.count({ where: { statusPageId: s.id, confirmedAt: { not: null } } }) : 0;
    return {
      tenantId,
      visibility: s?.visibility ?? 'CUSTOMER_ONLY',
      slug: s?.slug ?? null,
      title: s?.title ?? null,
      description: s?.description ?? null,
      confirmedSubscribers,
      components: instances.flatMap((i) =>
        i.components.map((c) => ({ id: c.id, instanceId: i.id, instanceName: i.name, name: c.name, label: c.label, hidden: c.hidden, sortOrder: c.sortOrder, status: c.status })),
      ),
    };
  }

  @Scope('incidents:write')
  @Put('status-pages/:tenantId')
  @ApiZodBody(updateStatusPageSchema)
  async update(
    @CurrentPrincipal() p: RequestPrincipal,
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @ZodBody(updateStatusPageSchema) body: z.infer<typeof updateStatusPageSchema>,
    @CorrelationId() correlationId: string,
  ): Promise<StatusPageSettingsDto> {
    authorize(p, 'update', 'StatusPage', { tenantId });
    if (!(await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true } }))) throw notFound('Tenant');
    if (body.slug) {
      const taken = await this.prisma.statusPage.findFirst({ where: { slug: body.slug, tenantId: { not: tenantId } }, select: { id: true } });
      if (taken) throw conflict('STATUS_SLUG_TAKEN', 'Another status page already uses this address.');
    }
    await this.prisma.statusPage.upsert({ where: { tenantId }, update: body, create: { tenantId, ...body } });
    await this.audit.record({ principal: p, tenantId, resourceType: 'StatusPage', resourceId: tenantId, action: 'UPDATE', correlationId, changes: body });
    return this.settings(p, tenantId);
  }

  @Scope('incidents:write')
  @Patch('status-pages/:tenantId/components/:componentId')
  @ApiZodBody(updateStatusComponentSchema)
  async updateComponent(
    @CurrentPrincipal() p: RequestPrincipal,
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('componentId', ParseUUIDPipe) componentId: string,
    @ZodBody(updateStatusComponentSchema) body: z.infer<typeof updateStatusComponentSchema>,
    @CorrelationId() correlationId: string,
  ) {
    authorize(p, 'update', 'StatusPage', { tenantId });
    const component = await this.prisma.statusComponent.findFirst({ where: { id: componentId, tenantId } });
    if (!component) throw notFound('Component');
    const row = await this.prisma.statusComponent.update({ where: { id: componentId }, data: body });
    await this.audit.record({ principal: p, tenantId, resourceType: 'StatusComponent', resourceId: componentId, action: 'UPDATE', correlationId, changes: body });
    return { id: row.id, name: row.name, label: row.label, hidden: row.hidden, sortOrder: row.sortOrder };
  }

  /** Email updates for the signed in user, confirmed at once: the address is their own. */
  @Put('status-pages/:tenantId/subscription')
  @HttpCode(204)
  async subscribeMe(@CurrentPrincipal() p: RequestPrincipal, @Param('tenantId', ParseUUIDPipe) tenantId: string) {
    if (p.apiKey) throw new AppError(403, 'API_KEY_NOT_ALLOWED', 'A person subscribes with their own address.');
    authorize(p, 'read', 'StatusPage', { tenantId });
    const page = await this.pageFor(tenantId);
    if (page.visibility === 'PRIVATE' && !this.may(p, 'update', tenantId)) throw notFound('Status page');
    const email = p.email.toLowerCase();
    await this.prisma.statusSubscription.upsert({
      where: { statusPageId_email: { statusPageId: page.id, email } },
      update: { userId: p.userId, confirmedAt: new Date() },
      create: { statusPageId: page.id, email, userId: p.userId, tokenHash: sha256(newToken()), confirmedAt: new Date() },
    });
  }

  @Delete('status-pages/:tenantId/subscription')
  @HttpCode(204)
  async unsubscribeMe(@CurrentPrincipal() p: RequestPrincipal, @Param('tenantId', ParseUUIDPipe) tenantId: string) {
    authorize(p, 'read', 'StatusPage', { tenantId });
    const page = await this.prisma.statusPage.findUnique({ where: { tenantId } });
    if (page) await this.prisma.statusSubscription.deleteMany({ where: { statusPageId: page.id, email: p.email.toLowerCase() } });
  }

  // Maintenance windows

  @Scope('instances:read')
  @Get('maintenance-windows')
  async listMaintenance(@CurrentPrincipal() p: RequestPrincipal, @Query('tenantId', ParseUUIDPipe) tenantId: string, @Query('include') include?: string): Promise<MaintenanceDto[]> {
    authorize(p, 'read', 'StatusPage', { tenantId });
    const rows = await this.prisma.maintenanceWindow.findMany({
      where: { tenantId, ...(include === 'past' ? {} : { endsAt: { gt: new Date() } }) },
      orderBy: { startsAt: include === 'past' ? 'desc' : 'asc' },
      take: 100,
    });
    const names = await this.instanceNames(rows);
    return rows.map((w) => toMaintenanceDto(w, w.instanceId ? (names.get(w.instanceId) ?? null) : null));
  }

  @Scope('incidents:write')
  @Post('maintenance-windows')
  @ApiZodBody(createMaintenanceSchema)
  async createMaintenance(
    @CurrentPrincipal() p: RequestPrincipal,
    @ZodBody(createMaintenanceSchema) body: z.infer<typeof createMaintenanceSchema>,
    @CorrelationId() correlationId: string,
  ): Promise<MaintenanceDto> {
    authorize(p, 'update', 'StatusPage', { tenantId: body.tenantId });
    if (Date.parse(body.endsAt) <= Date.now()) throw new AppError(422, 'MAINTENANCE_IN_PAST', 'This maintenance would already be over.');
    let instanceName: string | null = null;
    if (body.instanceId) {
      const instance = await this.prisma.instance.findFirst({ where: { id: body.instanceId, tenantId: body.tenantId }, select: { name: true } });
      if (!instance) throw notFound('Instance');
      instanceName = instance.name;
    }
    const row = await this.prisma.maintenanceWindow.create({
      data: {
        tenantId: body.tenantId,
        instanceId: body.instanceId ?? null,
        title: body.title,
        message: body.message ?? null,
        componentNames: body.componentNames,
        startsAt: new Date(body.startsAt),
        endsAt: new Date(body.endsAt),
        createdById: p.userId,
      },
    });
    await this.audit.record({ principal: p, tenantId: row.tenantId, resourceType: 'MaintenanceWindow', resourceId: row.id, action: 'CREATE', correlationId, changes: { title: row.title, startsAt: body.startsAt, endsAt: body.endsAt } });
    await this.queues.notify({
      tenantId: row.tenantId,
      event: 'maintenance.scheduled',
      title: `Scheduled maintenance: ${row.title}`,
      body: `From ${row.startsAt.toUTCString()} to ${row.endsAt.toUTCString()}.${row.message ? ` ${row.message}` : ''}`,
      link: `/status/${row.tenantId}`,
      data: { maintenanceId: row.id },
    });
    return toMaintenanceDto(row, instanceName);
  }

  @Scope('incidents:write')
  @Patch('maintenance-windows/:id')
  @ApiZodBody(updateMaintenanceSchema)
  async updateMaintenance(
    @CurrentPrincipal() p: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZodBody(updateMaintenanceSchema) body: z.infer<typeof updateMaintenanceSchema>,
    @CorrelationId() correlationId: string,
  ): Promise<MaintenanceDto> {
    const row = await this.loadMaintenance(p, id);
    authorize(p, 'update', 'StatusPage', { tenantId: row.tenantId });
    const startsAt = body.startsAt ? new Date(body.startsAt) : row.startsAt;
    const endsAt = body.endsAt ? new Date(body.endsAt) : row.endsAt;
    if (endsAt <= startsAt) throw new AppError(422, 'VALIDATION_FAILED', 'The end must be after the start.');
    const updated = await this.prisma.maintenanceWindow.update({
      where: { id },
      data: {
        ...body,
        startsAt,
        endsAt,
        // Moved into the future again: subscribers hear about the new start and end.
        ...(startsAt > new Date() ? { startedAt: null } : {}),
        ...(endsAt > new Date() ? { completedAt: null } : {}),
      },
    });
    await this.audit.record({ principal: p, tenantId: row.tenantId, resourceType: 'MaintenanceWindow', resourceId: id, action: 'UPDATE', correlationId, changes: body });
    const names = await this.instanceNames([updated]);
    return toMaintenanceDto(updated, updated.instanceId ? (names.get(updated.instanceId) ?? null) : null);
  }

  /** Cancels a window that has not started, or ends a running one now. */
  @Scope('incidents:write')
  @Delete('maintenance-windows/:id')
  @HttpCode(204)
  async removeMaintenance(@CurrentPrincipal() p: RequestPrincipal, @Param('id', ParseUUIDPipe) id: string, @CorrelationId() correlationId: string) {
    const row = await this.loadMaintenance(p, id);
    authorize(p, 'update', 'StatusPage', { tenantId: row.tenantId });
    const now = new Date();
    if (row.startsAt <= now && row.endsAt > now) await this.prisma.maintenanceWindow.update({ where: { id }, data: { endsAt: now } });
    else await this.prisma.maintenanceWindow.delete({ where: { id } });
    await this.audit.record({ principal: p, tenantId: row.tenantId, resourceType: 'MaintenanceWindow', resourceId: id, action: row.startsAt <= now ? 'END' : 'DELETE', correlationId, changes: { title: row.title } });
  }

  // Public page: no sign in, its own rate limits, names and states only.

  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('public/status/:slug')
  async publicStatus(@Param('slug') slug: string): Promise<PublicStatusDto> {
    const page = await this.publicPage(slug);
    const tenantId = page.tenantId;
    const now = new Date();
    const [instances, open, recent, windows] = await Promise.all([
      this.prisma.instance.findMany({
        where: { tenantId, status: { not: 'DESTROYED' } },
        include: { components: { orderBy: { position: 'asc' } } },
        orderBy: { name: 'asc' },
      }),
      this.prisma.incident.findMany({ where: { tenantId, status: { not: 'RESOLVED' } }, include: { updates: { orderBy: { at: 'desc' } } }, orderBy: { openedAt: 'desc' } }),
      this.prisma.incident.findMany({
        where: { tenantId, status: 'RESOLVED', resolvedAt: { gte: new Date(now.getTime() - PUBLIC_HISTORY_DAYS * 86_400_000) } },
        include: { updates: { orderBy: { at: 'desc' } } },
        orderBy: { resolvedAt: 'desc' },
        take: 20,
      }),
      this.prisma.maintenanceWindow.findMany({ where: { tenantId, endsAt: { gt: now } }, orderBy: { startsAt: 'asc' }, take: 20 }),
    ]);
    const names = new Map(instances.map((i) => [i.id, i.name]));
    const groups = instances
      .map((i) => {
        const components = shownComponents(i);
        return { name: i.name, status: instanceStatus(components, i.status), components: components.map((c) => ({ name: c.name, status: c.status })) };
      })
      .filter((g) => g.components.length > 0);
    const instanceName = (id: string | null) => (id ? (names.get(id) ?? null) : null);
    return {
      title: page.title ?? page.tenant.name,
      description: page.description,
      overall: worstStatus(groups.map((g) => g.status)),
      groups,
      openIncidents: open.map((i) => toPublicIncident(i, instanceName(i.instanceId))),
      recentIncidents: recent.map((i) => toPublicIncident(i, instanceName(i.instanceId))),
      maintenance: windows.map((w) => {
        const { title, message, componentNames, startsAt, endsAt, state } = toMaintenanceDto(w, null, now);
        return { title, message, componentNames, startsAt, endsAt, state };
      }),
    };
  }

  /**
   * Starts a subscription from the public page and emails a confirmation link. The answer is the
   * same whether or not the address was already subscribed, so it reveals no subscribers.
   */
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('public/status/:slug/subscriptions')
  @HttpCode(202)
  @ApiZodBody(subscribeStatusSchema)
  async publicSubscribe(@Param('slug') slug: string, @ZodBody(subscribeStatusSchema) body: z.infer<typeof subscribeStatusSchema>) {
    const page = await this.publicPage(slug);
    const email = body.email.toLowerCase();
    const existing = await this.prisma.statusSubscription.findUnique({ where: { statusPageId_email: { statusPageId: page.id, email } } });
    if (existing?.confirmedAt) return { accepted: true };
    const token = newToken();
    await this.prisma.statusSubscription.upsert({
      where: { statusPageId_email: { statusPageId: page.id, email } },
      update: { tokenHash: sha256(token) },
      create: { statusPageId: page.id, email, tokenHash: sha256(token) },
    });
    const base = this.config.WEB_PUBLIC_URL.replace(/\/+$/, '');
    const title = page.title ?? page.tenant.name;
    await this.queues.enqueueStatusEmail({
      kind: 'status',
      to: email,
      subject: `Confirm your subscription to ${title} status`,
      text: `Someone asked to receive email updates about incidents and maintenance on ${title}.

Confirm: ${base}/s/${page.slug}/confirm/${token}

If it was not you, ignore this email and nothing will be sent.`,
    });
    return { accepted: true };
  }

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('public/status/subscriptions/:token/confirm')
  @HttpCode(204)
  async confirm(@Param('token') token: string) {
    const sub = await this.prisma.statusSubscription.findUnique({ where: { tokenHash: sha256(token) } });
    if (!sub) throw notFound('Subscription');
    if (!sub.confirmedAt) await this.prisma.statusSubscription.update({ where: { id: sub.id }, data: { confirmedAt: new Date() } });
  }

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Delete('public/status/subscriptions/:token')
  @HttpCode(204)
  async unsubscribe(@Param('token') token: string) {
    // The link in every update email; a confirmation link that was never used also works.
    const id = verifyUnsubscribeToken(this.config.SESSION_SECRET, token);
    await this.prisma.statusSubscription.deleteMany({ where: id ? { id } : { tokenHash: sha256(token), confirmedAt: null } });
  }

  /** A page that is not public looks exactly like a missing one. */
  private async publicPage(slug: string): Promise<StatusPage & { tenant: { name: string } }> {
    const page = /^[a-z0-9][a-z0-9-]{2,40}$/.test(slug) ? await this.prisma.statusPage.findUnique({ where: { slug }, include: { tenant: { select: { name: true } } } }) : null;
    if (page?.visibility !== 'PUBLIC') throw notFound('Status page');
    return page;
  }

  private async pageFor(tenantId: string): Promise<StatusPage> {
    if (!(await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true } }))) throw notFound('Tenant');
    return this.prisma.statusPage.upsert({ where: { tenantId }, update: {}, create: { tenantId } });
  }

  private async loadMaintenance(p: RequestPrincipal, id: string): Promise<MaintenanceWindow> {
    const row = await this.prisma.maintenanceWindow.findUnique({ where: { id } });
    if (!row || !(isPlatformStaff(p) || p.memberships.some((m) => m.tenantId === row.tenantId))) throw notFound('Maintenance window');
    return row;
  }

  private async instanceNames(rows: { instanceId: string | null }[]) {
    const ids = [...new Set(rows.map((r) => r.instanceId).filter((id): id is string => !!id))];
    const instances = ids.length ? await this.prisma.instance.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
    return new Map(instances.map((i) => [i.id, i.name]));
  }

  private may(p: RequestPrincipal, action: 'update', tenantId: string): boolean {
    try {
      authorize(p, action, 'StatusPage', { tenantId });
      return true;
    } catch {
      return false;
    }
  }
}
