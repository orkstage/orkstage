// SPDX-License-Identifier: AGPL-3.0-only
import { type ApiKeyDto, createApiKeySchema, type ListQuery, listQuerySchema, type Page } from '@orkstage/contracts';
import type { ApiKey, PrismaClient } from '@orkstage/database';
import { sha256 } from '@orkstage/domain';
import { Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { randomBytes } from 'node:crypto';
import type { z } from 'zod';
import { AuditService } from '../common/audit.service.js';
import { authorize, CorrelationId, CurrentPrincipal, isPlatformStaff } from '../common/auth.js';
import { notFound, unprocessable } from '../common/errors.js';
import { iso, listOrder, page, pageArgs } from '../common/pagination.js';
import { ApiZodBody, ZodBody, ZodQuery } from '../common/validation.js';
import { PRISMA } from '../infra/infra.module.js';
import type { RequestPrincipal } from '../types.js';

export function toApiKeyDto(k: ApiKey): ApiKeyDto {
  return {
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    tenantId: k.tenantId,
    role: k.role,
    scopes: k.scopes,
    createdAt: k.createdAt.toISOString(),
    expiresAt: iso(k.expiresAt),
    lastUsedAt: iso(k.lastUsedAt),
    revokedAt: iso(k.revokedAt),
  };
}

/**
 * API keys (docs/specs/integration-api.md). Humans manage keys; keys cannot manage keys (these
 * routes declare no @Scope, so API-key callers are rejected).
 */
@ApiTags('api-keys')
@Controller('api-keys')
export class ApiKeysController {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async list(@CurrentPrincipal() p: RequestPrincipal, @ZodQuery(listQuerySchema) q: ListQuery): Promise<Page<ApiKeyDto>> {
    const tenantId = q.tenantId;
    // With a tenant filter: CASL check. Without: staff see all, customers only tenants they administer.
    if (tenantId) authorize(p, 'read', 'ApiKey', { tenantId });
    const rows = await this.prisma.apiKey.findMany({
      where: tenantId
        ? { tenantId }
        : isPlatformStaff(p)
          ? {}
          : { tenantId: { in: p.memberships.filter((m) => ['CustomerOwner', 'CustomerAdmin'].includes(m.role)).map((m) => m.tenantId) } },
      orderBy: listOrder(q.sort, { createdAt: 'createdAt', name: 'name' }, '-createdAt'),
      ...pageArgs(q),
    });
    return page(rows, q.limit, toApiKeyDto);
  }

  @Post()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiZodBody(createApiKeySchema)
  async create(
    @CurrentPrincipal() p: RequestPrincipal,
    @ZodBody(createApiKeySchema) body: z.infer<typeof createApiKeySchema>,
    @CorrelationId() correlationId: string,
  ): Promise<{ apiKey: ApiKeyDto; token: string }> {
    const platformRole = body.role.startsWith('Platform');
    if (platformRole && body.tenantId) throw unprocessable('INVALID_KEY_ROLE', 'Platform roles are only for organization-wide keys (omit tenantId).');
    if (!platformRole && !body.tenantId) throw unprocessable('TENANT_REQUIRED', 'Customer roles require a tenantId.');
    authorize(p, 'create', 'ApiKey', { tenantId: body.tenantId ?? null });
    // A key never outranks its creator: only platform admins/owners mint platform keys.
    if (platformRole && !['PlatformOwner', 'PlatformAdmin'].includes(p.platformRole ?? '')) {
      throw unprocessable('ROLE_TOO_HIGH', 'Only platform admins can create organization-wide keys.');
    }
    if (body.expiresAt && new Date(body.expiresAt) <= new Date()) throw unprocessable('INVALID_EXPIRY', 'expiresAt must be in the future.');

    const organizationId = body.tenantId
      ? (await this.prisma.tenant.findUnique({ where: { id: body.tenantId }, select: { organizationId: true } }))?.organizationId
      : (await this.prisma.organization.findFirst({ orderBy: { createdAt: 'asc' }, select: { id: true } }))?.id;
    if (!organizationId) throw notFound(body.tenantId ? 'Tenant' : 'Organization');

    const prefix = `ork_${body.environment}_${randomBytes(4).toString('hex')}`;
    const token = `${prefix}_${randomBytes(32).toString('base64url')}`;
    const key = await this.prisma.apiKey.create({
      data: {
        organizationId,
        tenantId: body.tenantId ?? null,
        name: body.name,
        prefix,
        tokenHash: sha256(token),
        role: body.role,
        scopes: body.scopes,
        createdById: p.userId,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
      },
    });
    await this.audit.record({ principal: p, tenantId: key.tenantId, resourceType: 'ApiKey', resourceId: key.id, action: 'CREATE', correlationId, changes: { name: key.name, prefix, role: key.role, scopes: key.scopes } });
    return { apiKey: toApiKeyDto(key), token };
  }

  @Delete(':id')
  @HttpCode(204)
  async revoke(@CurrentPrincipal() p: RequestPrincipal, @Param('id', ParseUUIDPipe) id: string, @CorrelationId() correlationId: string) {
    const key = await this.prisma.apiKey.findUnique({ where: { id } });
    if (!key) throw notFound('API key');
    authorize(p, 'delete', 'ApiKey', { tenantId: key.tenantId });
    if (!key.revokedAt) await this.prisma.apiKey.update({ where: { id }, data: { revokedAt: new Date() } });
    await this.audit.record({ principal: p, tenantId: key.tenantId, resourceType: 'ApiKey', resourceId: id, action: 'REVOKE', correlationId, changes: { prefix: key.prefix } });
  }
}
