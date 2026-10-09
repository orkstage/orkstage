import { createTenantSchema, updateTenantSchema, type PlanDto, type TenantDto } from '@orkstage/contracts';
import type { PrismaClient } from '@orkstage/database';
import { Controller, Get, Inject, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { AuditService } from '../common/audit.service.js';
import { authorize, CorrelationId, CurrentPrincipal, isPlatformStaff, Scope } from '../common/auth.js';
import { notFound, unprocessable } from '../common/errors.js';
import { ApiZodBody, ZodBody } from '../common/validation.js';
import { PRISMA } from '../infra/infra.module.js';
import type { RequestPrincipal } from '../types.js';

@ApiTags('tenants')
@Controller()
export class TenantsController {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
  ) {}

  @Scope('templates:read')
  @Get('plans')
  async plans(): Promise<PlanDto[]> {
    const plans = await this.prisma.plan.findMany({ orderBy: { createdAt: 'asc' } });
    return plans.map((p) => ({ id: p.id, code: p.code, name: p.name, entitlements: p.entitlements as Record<string, unknown> }));
  }

  @Scope('instances:read')
  @Get('tenants')
  async list(@CurrentPrincipal() p: RequestPrincipal): Promise<TenantDto[]> {
    const tenants = await this.prisma.tenant.findMany({
      where: isPlatformStaff(p) ? {} : { id: { in: p.memberships.map((m) => m.tenantId) } },
      include: { plan: true, _count: { select: { instances: { where: { status: { not: 'DESTROYED' } } } } } },
      orderBy: { name: 'asc' },
    });
    return tenants.map((t) => this.toDto(t));
  }

  @Post('tenants')
  @ApiZodBody(createTenantSchema)
  async create(
    @CurrentPrincipal() p: RequestPrincipal,
    @ZodBody(createTenantSchema) body: z.infer<typeof createTenantSchema>,
    @CorrelationId() correlationId: string,
  ): Promise<TenantDto> {
    authorize(p, 'create', 'Tenant');
    const plan = await this.prisma.plan.findUnique({ where: { code: body.planCode } });
    if (!plan) throw unprocessable('UNKNOWN_PLAN', `Plan ${body.planCode} does not exist.`);
    const org = await this.prisma.organization.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
    const tenant = await this.prisma.tenant.create({
      data: { organizationId: org.id, name: body.name, slug: body.slug, planId: plan.id, allowedEmailDomains: body.allowedEmailDomains },
      include: { plan: true, _count: { select: { instances: true } } },
    });
    await this.audit.record({ principal: p, tenantId: tenant.id, resourceType: 'Tenant', resourceId: tenant.id, action: 'CREATE', correlationId, changes: body });
    return this.toDto(tenant);
  }

  @Scope('instances:read')
  @Get('tenants/:id')
  async get(@CurrentPrincipal() p: RequestPrincipal, @Param('id', ParseUUIDPipe) id: string): Promise<TenantDto> {
    authorize(p, 'read', 'Tenant', { tenantId: id });
    const tenant = await this.prisma.tenant.findUnique({ where: { id }, include: { plan: true, _count: { select: { instances: true } } } });
    if (!tenant) throw notFound('Tenant');
    return this.toDto(tenant);
  }

  @Patch('tenants/:id')
  @ApiZodBody(updateTenantSchema)
  async update(
    @CurrentPrincipal() p: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZodBody(updateTenantSchema) body: z.infer<typeof updateTenantSchema>,
    @CorrelationId() correlationId: string,
  ): Promise<TenantDto> {
    authorize(p, 'update', 'Tenant', { tenantId: id });
    // Changing the plan is a platform decision, not a tenant self-service action.
    if (body.planCode) authorize(p, 'manage', 'Plan');
    const plan = body.planCode ? await this.prisma.plan.findUniqueOrThrow({ where: { code: body.planCode } }) : null;
    const tenant = await this.prisma.tenant.update({
      where: { id },
      data: { name: body.name, ...(plan ? { planId: plan.id } : {}) },
      include: { plan: true, _count: { select: { instances: true } } },
    });
    await this.audit.record({ principal: p, tenantId: id, resourceType: 'Tenant', resourceId: id, action: 'UPDATE', correlationId, changes: body });
    return this.toDto(tenant);
  }

  private toDto(t: { id: string; name: string; slug: string; createdAt: Date; plan: { code: string; name: string }; _count: { instances: number } }): TenantDto {
    return { id: t.id, name: t.name, slug: t.slug, plan: { code: t.plan.code, name: t.plan.name }, instanceCount: t._count.instances, createdAt: t.createdAt.toISOString() };
  }
}
