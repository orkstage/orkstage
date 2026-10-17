// SPDX-License-Identifier: AGPL-3.0-only
import {
  createInstanceSchema,
  destroyInstanceSchema,
  listQuerySchema,
  simulateSchema,
  updateInstanceSchema,
  upgradeInstanceSchema,
  type InstanceDto,
  type ListQuery,
  type ResourceDto,
} from '@orkstage/contracts';
import type { ResourceOutputs } from '@orkstage/cloud-core';
import type { Instance, InstanceResource, PrismaClient } from '@orkstage/database';
import { challengeName, isInstanceBusy, readTenantLimits } from '@orkstage/domain';
import { toCloudTarget } from '@orkstage/runtime';
import { Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { AuditService } from '../common/audit.service.js';
import { authorize, CorrelationId, CurrentPrincipal, scopedToTenant, tenantScope, Scope } from '../common/auth.js';
import { AppError, conflict, notFound, unprocessable } from '../common/errors.js';
import { iso, page } from '../common/pagination.js';
import { ApiZodBody, ZodBody, ZodQuery } from '../common/validation.js';
import { LauncherService, toDeploymentSummary } from '../deployments/launcher.service.js';
import { Adapters, PRISMA } from '../infra/infra.module.js';
import type { RequestPrincipal } from '../types.js';
import { CompileService } from './compile.service.js';

const instanceInclude = {
  tenant: { select: { name: true } },
  profile: { select: { id: true, name: true } },
  templateVersion: { include: { template: { select: { id: true, name: true, displayName: true } } } },
} as const;

type LoadedInstance = Instance & {
  tenant: { name: string };
  profile: { id: string; name: string } | null;
  templateVersion: { id: string; version: string; template: { id: string; name: string; displayName: string } };
};

export function toResourceDto(r: InstanceResource): ResourceDto {
  return {
    resourceId: r.resourceId,
    type: r.type,
    slot: r.slot,
    provider: r.provider,
    simulatedProvider: r.simulatedProvider,
    targetId: r.targetId,
    region: r.region,
    capability: r.capability,
    capabilityName: r.capabilityName,
    name: r.name,
    critical: r.critical,
    providerResourceId: r.providerResourceId,
    outputs: r.outputs as Record<string, unknown>,
    status: r.status,
    knowledge: r.knowledge,
    health: r.health,
    healthMessage: r.healthMessage,
    healthCheckedAt: iso(r.healthCheckedAt),
    drift: r.drift,
    driftCheckedAt: r.driftCheckedAt?.toISOString() ?? null,
    driftChanges: ((r.driftDetails as { actions?: { address: string; action: string }[] } | null)?.actions ?? []).slice(0, 50),
  };
}

@ApiTags('instances')
@Controller('instances')
export class InstancesController {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly compiler: CompileService,
    private readonly launcher: LauncherService,
    private readonly adapters: Adapters,
    private readonly audit: AuditService,
  ) {}

  @Scope('instances:read')
  @Get()
  async list(@CurrentPrincipal() p: RequestPrincipal, @ZodQuery(listQuerySchema) q: ListQuery) {
    const rows = await this.prisma.instance.findMany({
      where: { ...scopedToTenant(p, q.tenantId), ...(q.status ? { status: q.status as never } : {}) },
      include: instanceInclude,
      orderBy: { id: 'desc' },
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const simulated = await this.simulatedMap(rows);
    return page(rows, q.limit, (r) => this.toDto(r, simulated.get(r.id) ?? false));
  }

  @Scope('instances:write')
  @Post()
  @ApiZodBody(createInstanceSchema)
  async create(
    @CurrentPrincipal() p: RequestPrincipal,
    @ZodBody(createInstanceSchema) body: z.infer<typeof createInstanceSchema>,
    @CorrelationId() correlationId: string,
  ) {
    authorize(p, 'create', 'Instance', { tenantId: body.tenantId });
    const tenant = await this.prisma.tenant.findUnique({ where: { id: body.tenantId } });
    if (!tenant) throw notFound('Tenant');
    const version = await this.prisma.templateVersion.findUnique({ where: { id: body.templateVersionId } });
    if (!version || version.status !== 'PUBLISHED') throw unprocessable('TEMPLATE_NOT_PUBLISHED', 'Instances can only use published template versions.');

    const { maxInstances } = readTenantLimits(tenant.limits);
    if (maxInstances !== undefined) {
      const active = await this.prisma.instance.count({ where: { tenantId: tenant.id, status: { not: 'DESTROYED' } } });
      if (active >= maxInstances) throw unprocessable('QUOTA_EXCEEDED', `${tenant.name} is limited to ${maxInstances} instance(s).`);
    }

    // Compile before saving so an undeployable configuration is rejected up front.
    const id = randomUUID();
    const { bindings, profileId } = await this.compiler.withProfileBindings({
      tenantId: tenant.id,
      environment: body.environment,
      templateVersionId: version.id,
      bindings: body.bindings,
      profileId: body.profileId,
    });
    const resolved = await this.compiler.compile({ ...body, bindings, tenantId: tenant.id, instanceId: id, instanceSlug: body.slug });
    const blocking = resolved.issues.filter((i) => i.severity === 'error' && i.stage !== 'policy');
    if (blocking.length > 0) throw unprocessable('VALIDATION_FAILED', 'The selected template and placement are not valid.', { issues: resolved.issues });

    const instance = await this.prisma.instance.create({
      data: {
        id,
        tenantId: tenant.id,
        name: body.name,
        slug: body.slug,
        environment: body.environment,
        templateVersionId: version.id,
        variables: body.variables,
        labels: body.labels,
        bindings,
        profileId,
        createdById: p.userId,
      },
      include: instanceInclude,
    });
    await this.audit.record({ principal: p, tenantId: tenant.id, resourceType: 'Instance', resourceId: instance.id, action: 'CREATE', correlationId, changes: { name: body.name, template: version.id, bindings, profileId } });
    return this.toDto(instance, resolved.resources.every((r) => r.provider === 'mock'));
  }

  @Scope('instances:read')
  @Get(':id')
  async get(@CurrentPrincipal() p: RequestPrincipal, @Param('id', ParseUUIDPipe) id: string): Promise<InstanceDto> {
    const instance = await this.load(p, id, 'read');
    const [resources, last] = await Promise.all([
      this.prisma.instanceResource.findMany({ where: { instanceId: id }, orderBy: { createdAt: 'asc' } }),
      this.prisma.deployment.findFirst({ where: { instanceId: id }, orderBy: { queuedAt: 'desc' } }),
    ]);
    const simulated = (await this.simulatedMap([instance])).get(id) ?? false;
    return {
      ...this.toDto(instance, simulated),
      resources: resources.filter((r) => r.status !== 'DELETED').map(toResourceDto),
      lastDeployment: last ? toDeploymentSummary(last) : null,
    };
  }

  @Scope('instances:write')
  @Patch(':id')
  @ApiZodBody(updateInstanceSchema)
  async update(
    @CurrentPrincipal() p: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZodBody(updateInstanceSchema) body: z.infer<typeof updateInstanceSchema>,
    @CorrelationId() correlationId: string,
  ) {
    const instance = await this.load(p, id, 'update');
    if (isInstanceBusy(instance.status)) throw conflict('INSTANCE_BUSY', 'Wait for the current operation to finish.');
    if (body.bindings || body.variables || body.labels) {
      const resolved = await this.compiler.compile({
        tenantId: instance.tenantId,
        instanceId: id,
        instanceSlug: instance.slug,
        environment: instance.environment,
        templateVersionId: instance.templateVersionId,
        variables: (body.variables ?? instance.variables) as Record<string, string | number | boolean>,
        bindings: body.bindings ?? (instance.bindings as Record<string, { targetId: string; region: string }>),
        labels: body.labels ?? (instance.labels as Record<string, string>),
      });
      const blocking = resolved.issues.filter((i) => i.severity === 'error' && i.stage !== 'policy');
      if (blocking.length > 0) throw unprocessable('VALIDATION_FAILED', 'The new configuration is not valid.', { issues: resolved.issues });
    }
    const updated = await this.prisma.instance.update({
      where: { id },
      data: { name: body.name, variables: body.variables, bindings: body.bindings, protectedFromDestroy: body.protectedFromDestroy, labels: body.labels },
      include: instanceInclude,
    });
    await this.audit.record({ principal: p, tenantId: instance.tenantId, resourceType: 'Instance', resourceId: id, action: 'UPDATE', correlationId, changes: body });
    return this.toDto(updated, (await this.simulatedMap([updated])).get(id) ?? false);
  }

  /** Compile, policy check, cost estimate and plan diff — without touching any cloud. */
  @Scope('instances:read')
  @Post(':id/preview')
  @HttpCode(200)
  async preview(@CurrentPrincipal() p: RequestPrincipal, @Param('id', ParseUUIDPipe) id: string, @Query('templateVersionId') templateVersionId?: string) {
    const instance = await this.load(p, id, 'read');
    // ?templateVersionId= previews an upgrade or rollback: the plan from what runs to that version.
    if (templateVersionId) {
      const version = await this.prisma.templateVersion.findUnique({ where: { id: templateVersionId } });
      if (!version || version.status !== 'PUBLISHED' || version.templateId !== instance.templateVersion.template.id) {
        throw unprocessable('INVALID_UPGRADE', 'Previews must target a published version of the same template.');
      }
    }
    const resolved = await this.compiler.compile({
      tenantId: instance.tenantId,
      instanceId: id,
      instanceSlug: instance.slug,
      environment: instance.environment,
      templateVersionId: templateVersionId ?? instance.templateVersionId,
      variables: instance.variables as Record<string, string | number | boolean>,
      bindings: instance.bindings as Record<string, { targetId: string; region: string }>,
    });
    return this.compiler.toPreview(resolved, await this.compiler.knownResources(id), instance.name);
  }

  @Scope('instances:deploy')
  @Post(':id/deploy')
  @HttpCode(202)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async deploy(@CurrentPrincipal() p: RequestPrincipal, @Param('id', ParseUUIDPipe) id: string, @CorrelationId() correlationId: string) {
    const instance = await this.load(p, id, 'deploy');
    const { deployment } = await this.launcher.apply(instance, p, correlationId);
    return toDeploymentSummary(deployment);
  }

  /** Explicit template upgrade (spec §71). Existing infrastructure never changes silently. */
  @Scope('instances:write')
  @Post(':id/upgrade')
  @ApiZodBody(upgradeInstanceSchema)
  async upgrade(
    @CurrentPrincipal() p: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZodBody(upgradeInstanceSchema) body: z.infer<typeof upgradeInstanceSchema>,
    @CorrelationId() correlationId: string,
  ) {
    const instance = await this.load(p, id, 'update');
    if (isInstanceBusy(instance.status)) throw conflict('INSTANCE_BUSY', 'Wait for the current operation to finish.');
    const target = await this.prisma.templateVersion.findUnique({ where: { id: body.templateVersionId } });
    if (!target || target.status !== 'PUBLISHED' || target.templateId !== instance.templateVersion.template.id) {
      throw unprocessable('INVALID_UPGRADE', 'Upgrades must target a published version of the same template.');
    }
    if (target.id === instance.templateVersionId) throw unprocessable('SAME_VERSION', `The instance already runs version ${target.version}.`);
    // The instance keeps its current version until this deployment succeeds, so its record never
    // claims a version that is not provisioned. The deployment's plan shows the changes, and
    // production changes that delete or replace resources wait for approval.
    authorize(p, 'deploy', 'Instance', { tenantId: instance.tenantId });
    const { deployment } = await this.launcher.apply(instance, p, correlationId, target.id);
    const action = compareVersions(target.version, instance.templateVersion.version) < 0 ? 'ROLLBACK_TEMPLATE' : 'UPGRADE_TEMPLATE';
    await this.audit.record({ principal: p, tenantId: instance.tenantId, resourceType: 'Instance', resourceId: id, action, correlationId, changes: { from: instance.templateVersion.version, to: target.version, deploymentId: deployment.id } });
    return toDeploymentSummary(deployment);
  }

  @Scope('instances:deploy')
  @Post(':id/destroy')
  @HttpCode(202)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiZodBody(destroyInstanceSchema)
  async destroy(
    @CurrentPrincipal() p: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZodBody(destroyInstanceSchema) body: z.infer<typeof destroyInstanceSchema>,
    @CorrelationId() correlationId: string,
  ) {
    const instance = await this.load(p, id, 'destroy');
    if (body.confirm !== instance.slug) throw unprocessable('CONFIRMATION_MISMATCH', 'Type the instance slug exactly to confirm.');
    return toDeploymentSummary(await this.launcher.destroy(instance, p, correlationId));
  }

  @Scope('instances:read')
  @Get(':id/deployments')
  async deployments(@CurrentPrincipal() p: RequestPrincipal, @Param('id', ParseUUIDPipe) id: string, @ZodQuery(listQuerySchema) q: ListQuery) {
    await this.load(p, id, 'read');
    const rows = await this.prisma.deployment.findMany({
      where: { instanceId: id },
      orderBy: { id: 'desc' },
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    return page(rows, q.limit, toDeploymentSummary);
  }

  @Scope('instances:read')
  @Get(':id/logs')
  async logs(@CurrentPrincipal() p: RequestPrincipal, @Param('id', ParseUUIDPipe) id: string, @Query('resourceId') resourceId: string, @Query('limit') limit = '50') {
    await this.load(p, id, 'read');
    const { resource, adapter, ctx } = await this.resourceContext(id, resourceId);
    if (!adapter.getLogs) return { simulated: adapter.simulated, lines: [], note: 'This provider adapter does not expose logs yet.' };
    const lines = await adapter.getLogs(ctx, resource, Math.min(200, Math.max(1, Number(limit) || 50)));
    return { simulated: adapter.simulated, lines };
  }

  @Scope('instances:read')
  @Get(':id/metrics')
  async metrics(
    @CurrentPrincipal() p: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('resourceId') resourceId: string,
    @Query('metric') metric = 'cpu',
    @Query('minutes') minutes = '60',
  ) {
    await this.load(p, id, 'read');
    const { resource, adapter, ctx } = await this.resourceContext(id, resourceId);
    if (!adapter.getMetric) return { simulated: adapter.simulated, metric, points: [], note: 'This provider adapter does not expose metrics yet.' };
    const points = await adapter.getMetric(ctx, resource, metric, Math.min(1440, Math.max(5, Number(minutes) || 60)));
    return { simulated: adapter.simulated, metric, points };
  }

  /** Simulation controls (mock targets only): force health states or drift to exercise incidents. */
  @Scope('instances:deploy')
  @Post(':id/simulate')
  @HttpCode(204)
  @ApiZodBody(simulateSchema)
  async simulate(
    @CurrentPrincipal() p: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZodBody(simulateSchema) body: z.infer<typeof simulateSchema>,
    @CorrelationId() correlationId: string,
  ) {
    const instance = await this.load(p, id, 'deploy');
    const { resource, ctx } = await this.resourceContext(id, body.resourceId);
    if (resource.provider !== 'mock') throw unprocessable('NOT_SIMULATED', 'Simulation controls only apply to simulated resources.');
    if (body.health !== undefined) await this.adapters.mock.setHealthOverride(ctx, resource.name, body.health);
    if (body.drift !== undefined) await this.adapters.mock.simulateDrift(ctx, resource.name, body.drift);
    if (body.metric) await this.adapters.mock.setMetricOverride(ctx, resource.name, body.metric.name, body.metric.value);
    if (body.domain) {
      // Only hostnames of this instance: the simulated DNS is shared by every simulated target.
      const domain = await this.prisma.domain.findFirst({ where: { instanceId: id, hostname: body.domain.hostname.toLowerCase() } });
      if (!domain) throw notFound('Domain');
      if (body.domain.ownershipRecord !== undefined) {
        await this.adapters.mock.setDnsRecord(challengeName(domain.hostname), 'TXT', body.domain.ownershipRecord ? [domain.verificationToken] : null);
      }
      if (body.domain.certificateExpiresAt !== undefined) await this.adapters.mock.setCertificateExpiry(domain.hostname, body.domain.certificateExpiresAt);
    }
    await this.audit.record({ principal: p, tenantId: instance.tenantId, resourceType: 'InstanceResource', resourceId: `${id}/${body.resourceId}`, action: 'SIMULATE', correlationId, changes: body });
  }

  private async load(p: RequestPrincipal, id: string, action: 'read' | 'update' | 'deploy' | 'destroy'): Promise<LoadedInstance> {
    // Tenant scope in the query: a foreign instance is indistinguishable from a missing one.
    const instance = await this.prisma.instance.findFirst({ where: { id, ...tenantScope(p) }, include: instanceInclude });
    if (!instance) throw notFound('Instance');
    authorize(p, action, 'Instance', { tenantId: instance.tenantId });
    return instance;
  }

  private async resourceContext(instanceId: string, resourceId: string) {
    if (!resourceId) throw new AppError(400, 'VALIDATION_ERROR', 'resourceId is required.');
    const row = await this.prisma.instanceResource.findUnique({ where: { instanceId_resourceId: { instanceId, resourceId } } });
    if (!row || row.status === 'DELETED') throw notFound('Resource');
    const target = await this.prisma.cloudTarget.findUniqueOrThrow({ where: { id: row.targetId } });
    const adapter = this.adapters.registry.get(row.provider);
    return {
      adapter,
      ctx: { target: toCloudTarget(target), region: row.region, correlationId: randomUUID() },
      resource: {
        resourceId: row.resourceId,
        serviceKind: row.type,
        capability: row.capability,
        name: row.name,
        providerResourceId: row.providerResourceId ?? undefined,
        outputs: (row.outputs ?? undefined) as ResourceOutputs | undefined,
        provider: row.provider,
      },
    };
  }

  private async simulatedMap(instances: Instance[]): Promise<Map<string, boolean>> {
    const targetIds = new Set(instances.flatMap((i) => Object.values(i.bindings as Record<string, { targetId: string }>).map((b) => b.targetId)));
    const targets = await this.prisma.cloudTarget.findMany({ where: { id: { in: [...targetIds] } }, select: { id: true, provider: true } });
    const mock = new Set(targets.filter((t) => t.provider === 'mock').map((t) => t.id));
    return new Map(
      instances.map((i) => [i.id, Object.values(i.bindings as Record<string, { targetId: string }>).every((b) => mock.has(b.targetId))]),
    );
  }

  private toDto(i: LoadedInstance, simulated: boolean): InstanceDto {
    return {
      id: i.id,
      tenantId: i.tenantId,
      tenantName: i.tenant.name,
      name: i.name,
      slug: i.slug,
      environment: i.environment,
      status: i.status,
      health: i.health,
      simulated,
      template: {
        id: i.templateVersion.template.id,
        name: i.templateVersion.template.name,
        displayName: i.templateVersion.template.displayName,
        version: i.templateVersion.version,
        versionId: i.templateVersion.id,
      },
      variables: i.variables as Record<string, unknown>,
      bindings: i.bindings as Record<string, { targetId: string; region: string }>,
      profile: i.profile,
      protectedFromDestroy: i.protectedFromDestroy,
      labels: (i.labels ?? {}) as Record<string, string>,
      createdAt: i.createdAt.toISOString(),
      updatedAt: i.updatedAt.toISOString(),
    };
  }
}

/** Semantic version order (template versions are x.y.z). */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}
