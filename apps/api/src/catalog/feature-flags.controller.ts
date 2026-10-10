import { setFeatureFlagSchema, type FeatureFlagDto } from '@orkstage/contracts';
import type { PrismaClient } from '@orkstage/database';
import { FEATURE_FLAGS, isFeatureFlag } from '@orkstage/domain';
import { Controller, Delete, Get, HttpCode, Inject, Param, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { AuditService } from '../common/audit.service.js';
import { authorize, CorrelationId, CurrentPrincipal } from '../common/auth.js';
import { notFound } from '../common/errors.js';
import { ApiZodBody, ZodBody } from '../common/validation.js';
import { PRISMA } from '../infra/infra.module.js';
import type { RequestPrincipal } from '../types.js';

/**
 * Platform feature flags. Provider flags decide which clouds and platforms accept new targets
 * and deployments; only AWS and simulation are on by default. Reading needs `read Settings`,
 * changing needs `manage Settings` (platform owner). Every change is audited.
 */
@ApiTags('settings')
@Controller('feature-flags')
export class FeatureFlagsController {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async list(@CurrentPrincipal() p: RequestPrincipal): Promise<FeatureFlagDto[]> {
    authorize(p, 'read', 'Settings');
    const rows = await this.prisma.featureFlag.findMany();
    const tenantIds = [...new Set(rows.map((r) => r.tenantId).filter((t): t is string => t !== null))];
    const tenants = new Map((await this.prisma.tenant.findMany({ where: { id: { in: tenantIds } }, select: { id: true, name: true } })).map((t) => [t.id, t.name]));
    return FEATURE_FLAGS.map((f) => {
      const platform = rows.find((r) => r.key === f.key && r.tenantId === null)?.enabled ?? null;
      return {
        key: f.key,
        category: f.category,
        description: f.description,
        provider: f.provider ?? null,
        defaultEnabled: f.defaultEnabled,
        platform,
        tenants: rows
          .filter((r) => r.key === f.key && r.tenantId !== null)
          .map((r) => ({ tenantId: r.tenantId!, tenantName: tenants.get(r.tenantId!) ?? r.tenantId!, enabled: r.enabled })),
        enabled: platform ?? f.defaultEnabled,
      };
    });
  }

  @Put(':key')
  @HttpCode(204)
  @ApiZodBody(setFeatureFlagSchema)
  async set(
    @CurrentPrincipal() p: RequestPrincipal,
    @Param('key') key: string,
    @ZodBody(setFeatureFlagSchema) body: z.infer<typeof setFeatureFlagSchema>,
    @CorrelationId() correlationId: string,
  ) {
    authorize(p, 'manage', 'Settings');
    if (!isFeatureFlag(key)) throw notFound('Feature flag');
    if (body.tenantId && !(await this.prisma.tenant.findUnique({ where: { id: body.tenantId }, select: { id: true } }))) throw notFound('Tenant');
    const tenantId = body.tenantId ?? null;
    // Platform rows have a null tenant, which a compound unique cannot address in an upsert.
    const existing = await this.prisma.featureFlag.findFirst({ where: { key, tenantId } });
    if (existing) await this.prisma.featureFlag.update({ where: { id: existing.id }, data: { enabled: body.enabled } });
    else await this.prisma.featureFlag.create({ data: { key, tenantId, enabled: body.enabled } });
    await this.audit.record({ principal: p, tenantId, resourceType: 'FeatureFlag', resourceId: key, action: body.enabled ? 'ENABLE' : 'DISABLE', correlationId, changes: { key, tenantId, enabled: body.enabled } });
  }

  /** Removes an override so the platform value (or the default) applies again. */
  @Delete(':key')
  @HttpCode(204)
  async reset(@CurrentPrincipal() p: RequestPrincipal, @Param('key') key: string, @Query('tenantId') tenantId: string | undefined, @CorrelationId() correlationId: string) {
    authorize(p, 'manage', 'Settings');
    if (!isFeatureFlag(key)) throw notFound('Feature flag');
    await this.prisma.featureFlag.deleteMany({ where: { key, tenantId: tenantId ?? null } });
    await this.audit.record({ principal: p, tenantId: tenantId ?? null, resourceType: 'FeatureFlag', resourceId: key, action: 'RESET', correlationId, changes: { key, tenantId: tenantId ?? null } });
  }
}
