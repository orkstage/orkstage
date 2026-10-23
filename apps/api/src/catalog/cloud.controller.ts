// SPDX-License-Identifier: AGPL-3.0-only
import { type ApplicationDto, type CapabilityDto, type CloudTargetDto, createCloudTargetSchema, fixedConfigKeys, type ListQuery, listQuerySchema, type Page, PROVIDER_FORMS, providerConfigIssues, type ProviderDto, updateCloudTargetSchema, validateTargetSchema } from '@orkstage/contracts';
import { PROVIDER_INFO } from '@orkstage/domain';
import { Prisma, type CloudTarget as CloudTargetRow, type PrismaClient } from '@orkstage/database';
import { findSecretLikeKeys, toCloudTarget } from '@orkstage/runtime';
import { Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { z } from 'zod';
import { AuditService } from '../common/audit.service.js';
import { FeatureFlagsService } from '../common/feature-flags.service.js';
import { authorize, CorrelationId, CurrentPrincipal, Scope } from '../common/auth.js';
import { conflict, notFound, unprocessable } from '../common/errors.js';
import { iso, listOrder, page, pageArgs } from '../common/pagination.js';
import { ApiZodBody, ZodBody, ZodQuery } from '../common/validation.js';
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
    private readonly flags: FeatureFlagsService,
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

  /** Installed providers and whether their feature flag is on for the platform. */
  @Scope('targets:manage')
  @Get('cloud/providers')
  async providers(@CurrentPrincipal() p: RequestPrincipal): Promise<ProviderDto[]> {
    authorize(p, 'read', 'CloudTarget');
    const enabled = await this.flags.providerCheck(null);
    return this.adapters.registry.providers().map((provider) => ({
      provider,
      displayName: PROVIDER_INFO[provider].displayName,
      kind: PROVIDER_INFO[provider].kind,
      simulated: this.adapters.registry.get(provider).simulated,
      enabled: enabled(provider),
      form: PROVIDER_FORMS[provider],
    }));
  }

  @Scope('instances:read')
  @Get('cloud/targets')
  async list(@CurrentPrincipal() p: RequestPrincipal, @ZodQuery(listQuerySchema) q: ListQuery): Promise<Page<CloudTargetDto>> {
    authorize(p, 'read', 'CloudTarget');
    const rows = await this.prisma.cloudTarget.findMany({ orderBy: listOrder(q.sort, { createdAt: 'createdAt', name: 'name' }, 'createdAt'), ...pageArgs(q) });
    return page(rows, q.limit, (r) => this.toDto(r));
  }

  @Scope('targets:manage')
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
    const issues = providerConfigIssues(body.provider, body.config);
    if (issues.length > 0) throw unprocessable('INVALID_CONFIG', issues.join(' '), { issues });
    if (!body.allowedRegions.includes(body.defaultRegion)) throw unprocessable('INVALID_REGION', 'defaultRegion must be one of allowedRegions.');
    if (!this.adapters.registry.has(body.provider)) throw unprocessable('NO_ADAPTER', `No adapter is installed for ${body.provider} yet.`);
    await this.flags.assertProvider(body.provider, body.tenantId);
    const clash = await this.prisma.cloudTarget.findFirst({ where: { tenantId: body.tenantId ?? null, name: { equals: body.name, mode: 'insensitive' } }, select: { id: true } });
    if (clash) throw conflict('TARGET_NAME_TAKEN', `A cloud target named "${body.name}" already exists here.`);
    const row = await this.prisma.cloudTarget.create({ data: { ...body, config: body.config as object } });
    await this.audit.record({ principal: p, tenantId: row.tenantId, resourceType: 'CloudTarget', resourceId: row.id, action: 'CREATE', correlationId, changes: { provider: row.provider, name: row.name, regions: row.allowedRegions } });
    return this.toDto(row);
  }

  /**
   * Edits a target: rotate its role or credential reference, add regions, change the DNS zone.
   * The account and the state location stay (a different one is a new target), regions still in
   * use cannot be removed, and the last validation is cleared so the target is validated again.
   */
  @Scope('targets:manage')
  @Patch('cloud/targets/:id')
  @ApiZodBody(updateCloudTargetSchema)
  async update(
    @CurrentPrincipal() p: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZodBody(updateCloudTargetSchema) body: z.infer<typeof updateCloudTargetSchema>,
    @CorrelationId() correlationId: string,
  ): Promise<CloudTargetDto> {
    authorize(p, 'update', 'CloudTarget');
    const row = await this.prisma.cloudTarget.findUnique({ where: { id } });
    if (!row) throw notFound('Cloud target');

    const before = row.config as Record<string, unknown>;
    const config: Record<string, unknown> = { ...before };
    for (const [key, value] of Object.entries(body.config ?? {})) {
      if (value === null) delete config[key];
      else config[key] = value;
    }
    const fixed = fixedConfigKeys(row.provider).filter((key) => JSON.stringify(before[key] ?? null) !== JSON.stringify(config[key] ?? null));
    if (fixed.length > 0) {
      throw unprocessable('FIELD_FIXED', `${fixed.join(', ')} cannot change: it names the account or where existing state lives. Register a new target instead.`, { keys: fixed });
    }
    const secretKeys = findSecretLikeKeys(body.config ?? {});
    if (secretKeys.length > 0) {
      throw unprocessable('SECRET_IN_CONFIG', 'Target config must not contain secrets. Store them in the secret manager and pass a credentialRef.', { keys: secretKeys });
    }
    const issues = providerConfigIssues(row.provider, config);
    if (issues.length > 0) throw unprocessable('INVALID_CONFIG', issues.join(' '), { issues });

    const allowedRegions = body.allowedRegions ?? row.allowedRegions;
    const defaultRegion = body.defaultRegion ?? row.defaultRegion;
    if (!allowedRegions.includes(defaultRegion)) throw unprocessable('INVALID_REGION', 'defaultRegion must be one of allowedRegions.');
    const removed = row.allowedRegions.filter((r) => !allowedRegions.includes(r));
    if (removed.length > 0) {
      const inUse = await this.regionsInUse(id, removed);
      if (inUse.length > 0) throw conflict('REGION_IN_USE', `${inUse.join(', ')} still has resources, instances or profiles on this target.`, { regions: inUse });
    }
    if (body.name && body.name.toLowerCase() !== row.name.toLowerCase()) {
      const clash = await this.prisma.cloudTarget.findFirst({ where: { tenantId: row.tenantId, name: { equals: body.name, mode: 'insensitive' }, NOT: { id } }, select: { id: true } });
      if (clash) throw conflict('TARGET_NAME_TAKEN', `A cloud target named "${body.name}" already exists here.`);
    }

    const changed = [
      ...(body.name !== undefined && body.name !== row.name ? ['name'] : []),
      ...Object.keys(body.config ?? {}).filter((k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(config[k] ?? null)).map((k) => `config.${k}`),
      ...(body.credentialRef !== undefined && body.credentialRef !== row.credentialRef ? ['credentialRef'] : []),
      ...(body.allowedRegions && body.allowedRegions.join() !== row.allowedRegions.join() ? ['allowedRegions'] : []),
      ...(defaultRegion !== row.defaultRegion ? ['defaultRegion'] : []),
      ...(body.maxConcurrentDeployments !== undefined && body.maxConcurrentDeployments !== row.maxConcurrentDeployments ? ['maxConcurrentDeployments'] : []),
    ];
    if (changed.length === 0) return this.toDto(row);
    // Anything but the name or the concurrency limit can break the connection: validate again.
    const revalidate = changed.some((c) => c !== 'name' && c !== 'maxConcurrentDeployments');
    const updated = await this.prisma.cloudTarget.update({
      where: { id },
      data: {
        name: body.name,
        config: config as object,
        credentialRef: body.credentialRef,
        allowedRegions,
        defaultRegion,
        maxConcurrentDeployments: body.maxConcurrentDeployments,
        ...(revalidate ? { lastValidation: Prisma.DbNull, lastValidatedAt: null, health: 'UNKNOWN' } : {}),
      },
    });
    // Field names only: the values may name accounts and secret stores.
    await this.audit.record({ principal: p, tenantId: row.tenantId, resourceType: 'CloudTarget', resourceId: id, action: 'UPDATE', correlationId, changes: { fields: changed } });
    return this.toDto(updated);
  }

  /** Regions of a target that resources, instance bindings or profiles still point at. */
  private async regionsInUse(targetId: string, regions: string[]): Promise<string[]> {
    const used = new Set<string>();
    const resources = await this.prisma.instanceResource.findMany({ where: { targetId, region: { in: regions } }, select: { region: true }, distinct: ['region'] });
    for (const r of resources) used.add(r.region);
    const profiles = await this.prisma.profileTarget.findMany({ where: { targetId, region: { in: regions } }, select: { region: true } });
    for (const r of profiles) if (r.region) used.add(r.region);
    const instances = await this.prisma.instance.findMany({ where: { status: { not: 'DESTROYED' } }, select: { bindings: true } });
    for (const i of instances) {
      for (const b of Object.values((i.bindings ?? {}) as Record<string, { targetId?: string; region?: string }>)) {
        if (b?.targetId === targetId && b.region && regions.includes(b.region)) used.add(b.region);
      }
    }
    return [...used];
  }

  @Scope('targets:manage')
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
      maxConcurrentDeployments: r.maxConcurrentDeployments,
      status: r.status,
      health: r.health,
      lastValidation: (r.lastValidation ?? null) as CloudTargetDto['lastValidation'],
      lastValidatedAt: iso(r.lastValidatedAt),
    };
  }
}
