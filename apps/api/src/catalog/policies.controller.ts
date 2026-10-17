// SPDX-License-Identifier: AGPL-3.0-only
import { policyConfigSchema, tenantPolicySchema, type PolicyConfigDto, type TenantPolicyDto } from '@orkstage/contracts';
import type { PrismaClient } from '@orkstage/database';
import { effectivePolicy, POLICIES, type PolicyConfig } from '@orkstage/provisioning';
import { Controller, Get, Inject, Param, ParseUUIDPipe, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { AuditService } from '../common/audit.service.js';
import { authorize, CorrelationId, CurrentPrincipal, Scope } from '../common/auth.js';
import { forbidden, notFound, unprocessable } from '../common/errors.js';
import { ApiZodBody, ZodBody } from '../common/validation.js';
import { PRISMA } from '../infra/infra.module.js';
import type { RequestPrincipal } from '../types.js';

const BUILT_IN = Object.keys(POLICIES);

/**
 * Policies as data (spec §33, open item 12). The platform policy is a platform setting; each
 * tenant may add its own, which only tightens it (`effectivePolicy`). Every plan, preview and
 * deployment of an instance is checked against the effective policy, custom templates included
 * (spec §72).
 */
@ApiTags('settings')
@Controller()
export class PoliciesController {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
  ) {}

  @Scope('instances:read')
  @Get('policies')
  async platform(@CurrentPrincipal() p: RequestPrincipal): Promise<PolicyConfigDto> {
    if (!p.platformRole) throw forbidden();
    return this.platformPolicy();
  }

  // Changed by people only: no API key scope grants it.
  @Put('policies')
  @ApiZodBody(policyConfigSchema)
  async setPlatform(@CurrentPrincipal() p: RequestPrincipal, @ZodBody(policyConfigSchema) body: z.infer<typeof policyConfigSchema>, @CorrelationId() correlationId: string): Promise<PolicyConfigDto> {
    authorize(p, 'update', 'Policy');
    if (!p.platformRole) throw forbidden();
    const unknown = (body.disabled ?? []).filter((n) => !BUILT_IN.includes(n));
    if (unknown.length) throw unprocessable('UNKNOWN_POLICY', `Unknown policies: ${unknown.join(', ')}.`, { builtIn: BUILT_IN });
    await this.prisma.platformSetting.upsert({ where: { key: 'policy' }, update: { value: body as object }, create: { key: 'policy', value: body as object } });
    await this.audit.record({ principal: p, resourceType: 'Policy', resourceId: 'platform', action: 'UPDATE', correlationId, changes: body });
    return body;
  }

  @Scope('instances:read')
  @Get('tenants/:tenantId/policy')
  async tenant(@CurrentPrincipal() p: RequestPrincipal, @Param('tenantId', ParseUUIDPipe) tenantId: string): Promise<TenantPolicyDto> {
    authorize(p, 'read', 'Policy', { tenantId });
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { policy: true } });
    if (!tenant) throw notFound('Tenant');
    const platform = await this.platformPolicy();
    const own = (tenant.policy ?? {}) as PolicyConfig;
    return { platform, tenant: own, effective: effectivePolicy(platform, own), builtIn: BUILT_IN };
  }

  @Put('tenants/:tenantId/policy')
  @ApiZodBody(tenantPolicySchema)
  async setTenant(
    @CurrentPrincipal() p: RequestPrincipal,
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @ZodBody(tenantPolicySchema) body: z.infer<typeof tenantPolicySchema>,
    @CorrelationId() correlationId: string,
  ): Promise<TenantPolicyDto> {
    authorize(p, 'update', 'Policy', { tenantId });
    if (!(await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true } }))) throw notFound('Tenant');
    await this.prisma.tenant.update({ where: { id: tenantId }, data: { policy: body as object } });
    await this.audit.record({ principal: p, tenantId, resourceType: 'Policy', resourceId: tenantId, action: 'UPDATE', correlationId, changes: body });
    return this.tenant(p, tenantId);
  }

  private async platformPolicy(): Promise<PolicyConfig> {
    const row = await this.prisma.platformSetting.findUnique({ where: { key: 'policy' } });
    return (row?.value ?? {}) as PolicyConfig;
  }
}
