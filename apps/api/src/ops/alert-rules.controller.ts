// SPDX-License-Identifier: AGPL-3.0-only
import { createAlertRuleSchema, updateAlertRuleSchema, type AlertRuleDto } from '@orkstage/contracts';
import type { AlertRule, PrismaClient } from '@orkstage/database';
import { Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { AuditService } from '../common/audit.service.js';
import { authorize, CorrelationId, CurrentPrincipal, Scope } from '../common/auth.js';
import { notFound } from '../common/errors.js';
import { ApiZodBody, ZodBody } from '../common/validation.js';
import { isPlatformStaff } from '../common/tenancy.js';
import { PRISMA } from '../infra/infra.module.js';
import type { RequestPrincipal } from '../types.js';

function toDto(r: AlertRule): AlertRuleDto {
  return {
    id: r.id,
    tenantId: r.tenantId,
    name: r.name,
    condition: r.condition as unknown as AlertRuleDto['condition'],
    severity: r.severity,
    actions: r.actions,
    cooldownSeconds: r.cooldownSeconds,
    autoResolve: r.autoResolve,
    enabled: r.enabled,
    createdAt: r.createdAt.toISOString(),
  };
}

/**
 * Alert rules (open item 7): what opens an incident. Health rules count failed health checks;
 * metric rules compare a metric over a window with a threshold. Platform staff manage every rule,
 * including platform rules (no tenant) that apply to all tenants; tenant owners and admins manage
 * their tenant's rules; every member reads the rules that apply to them.
 */
@ApiTags('incidents')
@Controller('alert-rules')
export class AlertRulesController {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
  ) {}

  @Scope('instances:read')
  @Get()
  async list(@CurrentPrincipal() p: RequestPrincipal, @Query('tenantId') tenantId?: string): Promise<AlertRuleDto[]> {
    authorize(p, 'read', 'AlertRule');
    const mine = p.memberships.map((m) => m.tenantId);
    const visible = isPlatformStaff(p) ? {} : { OR: [{ tenantId: { in: mine } }, { tenantId: null }] };
    const rows = await this.prisma.alertRule.findMany({
      where: { AND: [visible, tenantId ? { OR: [{ tenantId }, { tenantId: null }] } : {}] },
      orderBy: [{ tenantId: 'asc' }, { name: 'asc' }],
    });
    return rows.map(toDto);
  }

  @Scope('incidents:write')
  @Post()
  @ApiZodBody(createAlertRuleSchema)
  async create(
    @CurrentPrincipal() p: RequestPrincipal,
    @ZodBody(createAlertRuleSchema) body: z.infer<typeof createAlertRuleSchema>,
    @CorrelationId() correlationId: string,
  ): Promise<AlertRuleDto> {
    authorize(p, 'create', 'AlertRule', { tenantId: body.tenantId ?? null });
    const row = await this.prisma.alertRule.create({ data: { ...body, tenantId: body.tenantId ?? null, condition: body.condition as object } });
    await this.audit.record({ principal: p, tenantId: row.tenantId, resourceType: 'AlertRule', resourceId: row.id, action: 'CREATE', correlationId, changes: { name: row.name, condition: body.condition } });
    return toDto(row);
  }

  @Scope('incidents:write')
  @Patch(':id')
  @ApiZodBody(updateAlertRuleSchema)
  async update(
    @CurrentPrincipal() p: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZodBody(updateAlertRuleSchema) body: z.infer<typeof updateAlertRuleSchema>,
    @CorrelationId() correlationId: string,
  ): Promise<AlertRuleDto> {
    const row = await this.load(p, id);
    authorize(p, 'update', 'AlertRule', { tenantId: row.tenantId });
    const updated = await this.prisma.alertRule.update({ where: { id }, data: { ...body, ...(body.condition ? { condition: body.condition as object } : {}) } });
    await this.audit.record({ principal: p, tenantId: row.tenantId, resourceType: 'AlertRule', resourceId: id, action: 'UPDATE', correlationId, changes: body });
    return toDto(updated);
  }

  @Scope('incidents:write')
  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentPrincipal() p: RequestPrincipal, @Param('id', ParseUUIDPipe) id: string, @CorrelationId() correlationId: string) {
    const row = await this.load(p, id);
    authorize(p, 'delete', 'AlertRule', { tenantId: row.tenantId });
    await this.prisma.alertRule.delete({ where: { id } });
    await this.audit.record({ principal: p, tenantId: row.tenantId, resourceType: 'AlertRule', resourceId: id, action: 'DELETE', correlationId, changes: { name: row.name } });
  }

  /** A rule of another tenant looks exactly like a missing one. */
  private async load(p: RequestPrincipal, id: string): Promise<AlertRule> {
    const row = await this.prisma.alertRule.findUnique({ where: { id } });
    const visible = row && (isPlatformStaff(p) || row.tenantId === null || p.memberships.some((m) => m.tenantId === row.tenantId));
    if (!row || !visible) throw notFound('Alert rule');
    return row;
  }
}
