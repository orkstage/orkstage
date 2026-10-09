import { createCloudTargetSchema, validateTargetSchema, type ApplicationDto, type CapabilityDto, type CloudTargetDto } from '@orkstage/contracts';
import type { CloudTarget as CloudTargetRow, PrismaClient } from '@orkstage/database';
import { findSecretLikeKeys, toCloudTarget } from '@orkstage/runtime';
import { Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { z } from 'zod';
import { AuditService } from '../common/audit.service.js';
import { authorize, CorrelationId, CurrentPrincipal, Scope } from '../common/auth.js';
import { notFound, unprocessable } from '../common/errors.js';
import { iso } from '../common/pagination.js';
import { ApiZodBody, ZodBody } from '../common/validation.js';
import { Adapters, PRISMA, Queues } from '../infra/infra.module.js';
import type { RequestPrincipal } from '../types.js';

const VALIDATION_TIMEOUT_MS = 20_000;

@ApiTags('cloud')
@Controller()
export class CloudController {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly adapters: Adapters,
    private readonly audit: AuditService,
    private readonly queues: Queues,
  ) {}

  @Scope('templates:read')
  @Get('applications')
  async applications(@CurrentPrincipal() p: RequestPrincipal): Promise<ApplicationDto[]> {
    authorize(p, 'read', 'Application');
    const apps = await this.prisma.application.findMany({ include: { versions: { orderBy: { createdAt: 'desc' } } }, orderBy: { name: 'asc' } });
    return apps.map((a) => ({
      id: a.id,
      name: a.name,
      displayName: a.displayName,
      registryKind: a.registryKind,
      repository: a.repository,
      port: a.port,
      healthPath: a.healthPath,
      versions: a.versions.map((v) => ({ version: v.version, imageUri: v.imageUri, digest: v.digest, architectures: v.architectures, scanStatus: v.scanStatus })),
    }));
  }

  @Get('cloud/providers')
  providers(@CurrentPrincipal() p: RequestPrincipal) {
    authorize(p, 'read', 'CloudTarget');
    return this.adapters.registry.providers().map((provider) => ({ provider, simulated: this.adapters.registry.get(provider).simulated }));
  }

  @Scope('instances:read')
  @Get('cloud/targets')
  async list(@CurrentPrincipal() p: RequestPrincipal): Promise<CloudTargetDto[]> {
    authorize(p, 'read', 'CloudTarget');
    const rows = await this.prisma.cloudTarget.findMany({ orderBy: { createdAt: 'asc' } });
    return rows.map((r) => this.toDto(r));
  }

  @Post('cloud/targets')
  @ApiZodBody(createCloudTargetSchema)
  async create(
    @CurrentPrincipal() p: RequestPrincipal,
    @ZodBody(createCloudTargetSchema) body: z.infer<typeof createCloudTargetSchema>,
    @CorrelationId() correlationId: string,
  ): Promise<CloudTargetDto> {
    authorize(p, 'create', 'CloudTarget');
    const secretKeys = findSecretLikeKeys(body.config);
    if (secretKeys.length > 0) {
      throw unprocessable('SECRET_IN_CONFIG', 'Target config must not contain secrets. Store them in the secret manager and pass a credentialRef.', { keys: secretKeys });
    }
    if (!body.allowedRegions.includes(body.defaultRegion)) throw unprocessable('INVALID_REGION', 'defaultRegion must be one of allowedRegions.');
    if (!this.adapters.registry.has(body.provider)) throw unprocessable('NO_ADAPTER', `No adapter is installed for ${body.provider} yet.`);
    const row = await this.prisma.cloudTarget.create({ data: { ...body, config: body.config as object } });
    await this.audit.record({ principal: p, tenantId: row.tenantId, resourceType: 'CloudTarget', resourceId: row.id, action: 'CREATE', correlationId, changes: { provider: row.provider, name: row.name, regions: row.allowedRegions } });
    return this.toDto(row);
  }

  @Post('cloud/targets/:id/validate')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiZodBody(validateTargetSchema)
  async validate(
    @CurrentPrincipal() p: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZodBody(validateTargetSchema) body: z.infer<typeof validateTargetSchema>,
    @CorrelationId() correlationId: string,
  ): Promise<CloudTargetDto> {
    authorize(p, 'update', 'CloudTarget');
    const row = await this.prisma.cloudTarget.findUnique({ where: { id } });
    if (!row) throw notFound('Cloud target');
    const adapter = this.adapters.registry.get(row.provider);
    const signal = AbortSignal.timeout(VALIDATION_TIMEOUT_MS);
    const result = await adapter.validateTarget({ target: toCloudTarget(row), region: body.region ?? row.defaultRegion, correlationId, signal });
    const updated = await this.prisma.cloudTarget.update({
      where: { id },
      data: { lastValidation: result as object, lastValidatedAt: new Date(), health: result.ok ? 'HEALTHY' : 'UNHEALTHY' },
    });
    await this.audit.record({ principal: p, tenantId: row.tenantId, resourceType: 'CloudTarget', resourceId: id, action: 'VALIDATE', result: result.ok ? 'SUCCESS' : 'FAILURE', correlationId });
    // Tenant-owned targets: tell the tenant when the connection breaks (once, on the transition).
    if (!result.ok && row.health !== 'UNHEALTHY' && row.tenantId) {
      await this.queues.notify({
        tenantId: row.tenantId,
        event: 'cloud_target.unhealthy',
        title: `Cloud target ${row.name} failed validation`,
        body: 'Deployments to this target will fail until the connection is fixed. Open the target to see which check failed.',
        link: '/cloud-targets',
        data: { cloudTargetId: row.id, provider: row.provider },
      });
    }
    return this.toDto(updated);
  }

  @Scope('instances:read')
  @Get('cloud/targets/:id/capabilities')
  async capabilities(@CurrentPrincipal() p: RequestPrincipal, @Param('id', ParseUUIDPipe) id: string): Promise<CapabilityDto[]> {
    authorize(p, 'read', 'CloudTarget');
    const row = await this.prisma.cloudTarget.findUnique({ where: { id } });
    if (!row) throw notFound('Cloud target');
    return this.adapters.registry
      .get(row.provider)
      .capabilities(toCloudTarget(row))
      .map((c) => ({
        provider: c.provider,
        serviceKind: c.serviceKind,
        capability: c.capability,
        displayName: c.displayName,
        isDefault: Boolean(c.isDefault),
        features: c.features,
        limitations: c.limitations ?? [],
      }));
  }

  private toDto(r: CloudTargetRow): CloudTargetDto {
    const config = r.config as Record<string, unknown>;
    return {
      id: r.id,
      tenantId: r.tenantId,
      provider: r.provider,
      simulated: r.provider === 'mock',
      simulates: r.provider === 'mock' ? String(config.simulate ?? 'aws') : null,
      name: r.name,
      environment: r.environment,
      config,
      hasCredentialRef: Boolean(r.credentialRef),
      allowedRegions: r.allowedRegions,
      defaultRegion: r.defaultRegion,
      status: r.status,
      health: r.health,
      lastValidation: (r.lastValidation ?? null) as CloudTargetDto['lastValidation'],
      lastValidatedAt: iso(r.lastValidatedAt),
    };
  }
}
