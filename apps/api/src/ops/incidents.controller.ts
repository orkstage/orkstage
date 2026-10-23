// SPDX-License-Identifier: AGPL-3.0-only
import { createIncidentSchema, incidentUpdateSchema, listQuerySchema, type IncidentDto, type ListQuery } from '@orkstage/contracts';
import type { Incident, IncidentUpdate, PrismaClient } from '@orkstage/database';
import { platformMetrics } from '@orkstage/runtime';
import { Controller, Get, Inject, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { AuditService } from '../common/audit.service.js';
import { authorize, CorrelationId, CurrentPrincipal, scopedToTenant, tenantScope, Scope } from '../common/auth.js';
import { notFound, unprocessable } from '../common/errors.js';
import { iso, listOrder, page, pageArgs } from '../common/pagination.js';
import { ApiZodBody, ZodBody, ZodQuery } from '../common/validation.js';
import { PRISMA, Queues } from '../infra/infra.module.js';
import type { RequestPrincipal } from '../types.js';

export function toIncidentDto(i: Incident & { updates?: IncidentUpdate[] }): IncidentDto {
  return {
    id: i.id,
    tenantId: i.tenantId,
    instanceId: i.instanceId,
    title: i.title,
    status: i.status,
    impact: i.impact,
    severity: i.severity,
    source: i.source,
    openedAt: i.openedAt.toISOString(),
    resolvedAt: iso(i.resolvedAt),
    updates: i.updates?.map((u) => ({ id: u.id, status: u.status, message: u.message, at: u.at.toISOString() })),
  };
}

@ApiTags('incidents')
@Controller('incidents')
export class IncidentsController {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly queues: Queues,
    private readonly audit: AuditService,
  ) {}

  @Scope('instances:read')
  @Get()
  async list(@CurrentPrincipal() p: RequestPrincipal, @ZodQuery(listQuerySchema) q: ListQuery) {
    const rows = await this.prisma.incident.findMany({
      where: {
        ...scopedToTenant(p, q.tenantId),
        ...(q.instanceId ? { instanceId: q.instanceId } : {}),
        ...(q.status === 'open' ? { status: { not: 'RESOLVED' } } : q.status ? { status: q.status as never } : {}),
      },
      orderBy: listOrder(q.sort, { createdAt: 'id' }, '-createdAt'),
      ...pageArgs(q),
    });
    return page(rows, q.limit, (i) => toIncidentDto(i));
  }

  @Scope('incidents:write')
  @Post()
  @ApiZodBody(createIncidentSchema)
  async create(
    @CurrentPrincipal() p: RequestPrincipal,
    @ZodBody(createIncidentSchema) body: z.infer<typeof createIncidentSchema>,
    @CorrelationId() correlationId: string,
  ): Promise<IncidentDto> {
    authorize(p, 'create', 'Incident', { tenantId: body.tenantId });
    if (body.instanceId) {
      const instance = await this.prisma.instance.findFirst({ where: { id: body.instanceId, tenantId: body.tenantId } });
      if (!instance) throw unprocessable('INSTANCE_TENANT_MISMATCH', 'The instance does not belong to this tenant.');
    }
    const incident = await this.prisma.incident.create({
      data: {
        tenantId: body.tenantId,
        instanceId: body.instanceId,
        title: body.title,
        impact: body.impact,
        severity: body.severity,
        componentIds: body.componentIds,
        createdById: p.userId,
        updates: { create: { status: 'INVESTIGATING', message: body.message, createdById: p.userId } },
      },
      include: { updates: true },
    });
    platformMetrics.incidentOpened('manual');
    await this.queues.notify({ tenantId: body.tenantId, event: 'incident.opened', title: `Incident: ${body.title}`, body: body.message, link: `/incidents/${incident.id}` });
    await this.audit.record({ principal: p, tenantId: body.tenantId, resourceType: 'Incident', resourceId: incident.id, action: 'CREATE', correlationId, changes: { title: body.title, impact: body.impact } });
    return toIncidentDto(incident);
  }

  @Scope('instances:read')
  @Get(':id')
  async get(@CurrentPrincipal() p: RequestPrincipal, @Param('id', ParseUUIDPipe) id: string): Promise<IncidentDto> {
    const incident = await this.prisma.incident.findFirst({ where: { id, ...tenantScope(p) }, include: { updates: { orderBy: { at: 'desc' } } } });
    if (!incident) throw notFound('Incident');
    authorize(p, 'read', 'Incident', { tenantId: incident.tenantId });
    return toIncidentDto(incident);
  }

  @Scope('incidents:write')
  @Post(':id/updates')
  @ApiZodBody(incidentUpdateSchema)
  async addUpdate(
    @CurrentPrincipal() p: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZodBody(incidentUpdateSchema) body: z.infer<typeof incidentUpdateSchema>,
    @CorrelationId() correlationId: string,
  ): Promise<IncidentDto> {
    const incident = await this.prisma.incident.findFirst({ where: { id, ...tenantScope(p) } });
    if (!incident) throw notFound('Incident');
    authorize(p, 'update', 'Incident', { tenantId: incident.tenantId });
    const resolved = body.status === 'RESOLVED';
    if (resolved && incident.status !== 'RESOLVED') platformMetrics.incidentResolved(incident.openedAt);
    const updated = await this.prisma.incident.update({
      where: { id },
      data: {
        status: body.status,
        impact: body.impact,
        resolvedAt: resolved ? new Date() : null,
        updates: { create: { status: body.status, message: body.message, createdById: p.userId } },
      },
      include: { updates: { orderBy: { at: 'desc' } } },
    });
    await this.queues.notify({
      tenantId: incident.tenantId,
      event: resolved ? 'incident.resolved' : 'incident.updated',
      title: `${resolved ? 'Resolved' : 'Update'}: ${incident.title}`,
      body: body.message,
      link: `/incidents/${id}`,
    });
    await this.audit.record({ principal: p, tenantId: incident.tenantId, resourceType: 'Incident', resourceId: id, action: 'UPDATE', correlationId, changes: { status: body.status } });
    return toIncidentDto(updated);
  }
}
