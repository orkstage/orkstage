// SPDX-License-Identifier: AGPL-3.0-only
import { listQuerySchema, runTriggerSchema, type ListQuery, type TriggerDto, type TriggerRunDto } from '@orkstage/contracts';
import type { ResourceActionDescriptor } from '@orkstage/cloud-core';
import type { Instance, PrismaClient, TemplateVersion, TriggerRun } from '@orkstage/database';
import { type CatalogAction, catalogAction, type CloudProvider, minimumRoleFor, readTenantLimits, roleAtLeast, stricterRole } from '@orkstage/domain';
import { resolveAction, resolveTriggerParams, scaleRange, toProviderParams, triggerAllows, withProviderParams } from '@orkstage/provisioning';
import { environmentTemplate, type TemplateTrigger } from '@orkstage/templates';
import { Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { AuditService } from '../common/audit.service.js';
import { authorize, CorrelationId, CurrentPrincipal, isPlatformStaff, Scope, tenantScope } from '../common/auth.js';
import { AppError, conflict, notFound, unprocessable } from '../common/errors.js';
import { page } from '../common/pagination.js';
import { ApiZodBody, ZodBody, ZodQuery } from '../common/validation.js';
import { LauncherService } from '../deployments/launcher.service.js';
import { Adapters, PRISMA, Queues } from '../infra/infra.module.js';
import type { RequestPrincipal } from '../types.js';

export function toTriggerRunDto(r: TriggerRun): TriggerRunDto {
  return {
    id: r.id,
    instanceId: r.instanceId,
    trigger: r.trigger,
    resourceId: r.resourceId,
    action: r.action,
    params: r.params as Record<string, string | number | boolean>,
    source: r.source,
    status: r.status,
    approvedAt: r.approvedAt?.toISOString() ?? null,
    reference: r.reference,
    url: r.url,
    message: r.message,
    errorClass: r.errorClass,
    queuedAt: r.queuedAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
  };
}

/**
 * Template triggers on a deployed instance. People run them from the console or CLI (MANUAL); API
 * keys with `instances:deploy` run the ones marked `on.webhook` (CI pipelines, a CMS publishing);
 * cron runs the scheduled ones in the worker. Every run is recorded, audited and notified.
 */
@ApiTags('instances')
@Controller('instances')
export class TriggersController {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly adapters: Adapters,
    private readonly queues: Queues,
    private readonly audit: AuditService,
    private readonly launcher: LauncherService,
  ) {}

  @Scope('instances:read')
  @Get(':id/triggers')
  async list(@CurrentPrincipal() p: RequestPrincipal, @Param('id', ParseUUIDPipe) id: string): Promise<TriggerDto[]> {
    const instance = await this.load(p, id, 'read');
    const triggers = this.triggersOf(instance.templateVersion.document);
    if (triggers.length === 0) return [];
    const [resources, runs] = await Promise.all([
      this.prisma.instanceResource.findMany({ where: { instanceId: id, status: 'ACTIVE' } }),
      this.prisma.triggerRun.findMany({ where: { instanceId: id }, orderBy: { queuedAt: 'desc' }, take: 100 }),
    ]);
    return triggers.map((t) => {
      const row = resources.find((r) => r.resourceId === t.resource);
      const adapter = row && this.adapters.registry.has(row.provider) ? this.adapters.registry.get(row.provider) : undefined;
      const provided = row && adapter?.actions ? resolveAction(t.action, row.type, row.provider, adapter.actions(row.capability)) : undefined;
      const platform = row && !provided ? this.platformAction(t.action, row) : undefined;
      const resolved = provided ?? (platform?.ok ? { descriptor: descriptorOf(platform.action), catalog: platform.action, params: {} as Record<string, string> } : undefined);
      const reason = !row
        ? 'The resource is not deployed.'
        : platform && !platform.ok
          ? platform.reason
          : !resolved
            ? `${row.provider} does not offer "${t.action}" for ${row.capability}.`
            : null;
      // Parameters under the names the template uses (catalog names for a catalog action).
      const back = Object.fromEntries(Object.entries(resolved?.params ?? {}).map(([catalog, own]) => [own, catalog]));
      const last = runs.find((r) => r.trigger === t.name);
      return {
        name: t.name,
        description: t.description ?? null,
        resourceId: t.resource,
        action: t.action,
        params: t.params,
        overridable: t.overridable,
        on: { manual: t.on.manual, webhook: t.on.webhook, schedule: t.on.schedule ?? null },
        available: reason === null,
        unavailableReason: reason,
        actionParams: (resolved?.descriptor.params ?? []).map((param) => ({ ...param, name: back[param.name] ?? param.name })),
        provider: row?.provider ?? null,
        catalogAction: resolved?.catalog ? { id: resolved.catalog.id, risk: resolved.catalog.risk, reversible: resolved.catalog.reversible } : null,
        requiredRole: stricterRole(minimumRoleFor(resolved?.catalog?.risk), t.role),
        lastRun: last ? toTriggerRunDto(last) : null,
      };
    });
  }

  @Scope('instances:read')
  @Get(':id/trigger-runs')
  async runs(@CurrentPrincipal() p: RequestPrincipal, @Param('id', ParseUUIDPipe) id: string, @ZodQuery(listQuerySchema) q: ListQuery) {
    await this.load(p, id, 'read');
    const rows = await this.prisma.triggerRun.findMany({
      where: { instanceId: id },
      orderBy: { id: 'desc' },
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    return page(rows, q.limit, toTriggerRunDto);
  }

  @Scope('instances:deploy')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post(':id/triggers/:name/runs')
  @HttpCode(202)
  @ApiZodBody(runTriggerSchema)
  async run(
    @CurrentPrincipal() p: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('name') name: string,
    @ZodBody(runTriggerSchema) body: z.infer<typeof runTriggerSchema>,
    @CorrelationId() correlationId: string,
  ): Promise<TriggerRunDto> {
    const instance = await this.load(p, id, 'deploy');
    const trigger = this.triggersOf(instance.templateVersion.document).find((t) => t.name === name);
    if (!trigger) throw notFound('Trigger');
    const source = p.apiKey ? 'WEBHOOK' : 'MANUAL';
    if (!triggerAllows(trigger, source)) {
      throw new AppError(403, 'TRIGGER_NOT_ALLOWED', source === 'WEBHOOK' ? `"${name}" does not accept API key calls (on.webhook is off).` : `"${name}" cannot be run by hand (on.manual is off).`);
    }
    if (!['READY', 'DEGRADED'].includes(instance.status)) {
      throw unprocessable('INSTANCE_NOT_RUNNING', `Triggers run on deployed instances; this one is ${instance.status}.`);
    }

    const row = await this.prisma.instanceResource.findUnique({ where: { instanceId_resourceId: { instanceId: id, resourceId: trigger.resource } } });
    if (row?.status !== 'ACTIVE') throw unprocessable('RESOURCE_NOT_DEPLOYED', `Resource "${trigger.resource}" is not deployed.`);
    const adapter = this.adapters.registry.has(row.provider) ? this.adapters.registry.get(row.provider) : undefined;
    const provided = adapter?.actions ? resolveAction(trigger.action, row.type, row.provider, adapter.actions(row.capability)) : undefined;
    const platform = provided ? undefined : this.platformAction(trigger.action, row);
    if (platform && !platform.ok) throw unprocessable('ACTION_UNAVAILABLE', platform.reason);
    const action = provided ?? (platform ? { descriptor: descriptorOf(platform.action), catalog: platform.action, params: {} as Record<string, string> } : undefined);
    if (!action) throw unprocessable('ACTION_UNAVAILABLE', `${row.provider} does not offer "${trigger.action}" for ${row.capability}.`);
    // Safe actions need a developer, anything else an admin; the template may ask for more (ADR 0009).
    const required = stricterRole(minimumRoleFor(action.catalog?.risk), trigger.role);
    if (!isPlatformStaff(p) && !p.memberships.some((m) => m.tenantId === instance.tenantId && roleAtLeast(m.role, required))) {
      throw new AppError(403, 'ACTION_ROLE_REQUIRED', `Running "${name}" needs the ${required} role or higher (${action.catalog ? `${action.catalog.risk} action` : 'provider specific action'}).`);
    }
    const resolved = resolveTriggerParams(withProviderParams(trigger, action.params), toProviderParams(body.params, action.params), action.descriptor);
    if (!resolved.ok) throw unprocessable('INVALID_TRIGGER_PARAMS', resolved.errors[0]!, { errors: resolved.errors });
    if (action.catalog?.id === 'service.scale') {
      const replicas = resolved.params[action.params.replicas ?? 'replicas'];
      const resource = environmentTemplate.safeParse(instance.templateVersion.document).data?.spec.resources.find((r) => r.id === trigger.resource);
      const tenant = await this.prisma.tenant.findUniqueOrThrow({ where: { id: instance.tenantId }, select: { limits: true } });
      const range = scaleRange(resource, readTenantLimits(tenant.limits).maxReplicasPerService);
      if (typeof replicas !== 'number' || !Number.isInteger(replicas) || replicas < range.min || replicas > range.max) {
        throw unprocessable('INVALID_TRIGGER_PARAMS', `replicas must be a whole number from ${range.min} to ${range.max}.`);
      }
    }

    if (platform) {
      const problem = platformParamProblem(platform.action, resolved.params);
      if (problem) throw unprocessable('INVALID_TRIGGER_PARAMS', problem);
    }

    // Disruptive and destructive actions on production wait for a person, like deployments (ADR 0009).
    const awaitsApproval = instance.environment === 'production' && (action.catalog?.risk ?? 'disruptive') !== 'safe';
    const run = await this.prisma.triggerRun.create({
      data: {
        tenantId: instance.tenantId,
        instanceId: id,
        trigger: name,
        resourceId: trigger.resource,
        action: trigger.action,
        params: resolved.params,
        source,
        status: awaitsApproval ? 'AWAITING_APPROVAL' : 'QUEUED',
        requestedById: p.apiKey ? null : p.userId,
        apiKeyId: p.apiKey?.id ?? null,
        correlationId: correlationId || randomUUID(),
      },
    });
    await this.audit.record({ principal: p, tenantId: instance.tenantId, resourceType: 'TriggerRun', resourceId: run.id, action: 'RUN_TRIGGER', correlationId, changes: { instanceId: id, trigger: name, params: resolved.params, awaitsApproval } });
    if (awaitsApproval) {
      await this.queues.notify({
        tenantId: instance.tenantId,
        event: 'trigger.awaiting_approval',
        title: `${name} awaits approval`,
        body: `${trigger.action} on the production instance ${instance.name} needs approval before it runs.`,
        link: `/instances/${id}`,
        data: { instanceId: id, triggerRunId: run.id, trigger: name, action: trigger.action, status: 'AWAITING_APPROVAL' },
      });
      return toTriggerRunDto(run);
    }
    if (platform) return toTriggerRunDto(await this.runPlatform(run, platform.action, instance, p, correlationId));
    await this.queues.enqueueTrigger(run.id);
    return toTriggerRunDto(run);
  }

  /** Runs a trigger run that waited for approval (ADR 0009). The approver needs the action's role. */
  @Scope('instances:deploy')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post(':id/trigger-runs/:runId/approve')
  @HttpCode(200)
  async approve(
    @CurrentPrincipal() p: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('runId', ParseUUIDPipe) runId: string,
    @CorrelationId() correlationId: string,
  ): Promise<TriggerRunDto> {
    const instance = await this.load(p, id, 'deploy');
    authorize(p, 'approve', 'Instance', { tenantId: instance.tenantId });
    const run = await this.prisma.triggerRun.findFirst({ where: { id: runId, instanceId: id } });
    if (!run) throw notFound('Trigger run');
    const trigger = this.triggersOf(instance.templateVersion.document).find((t) => t.name === run.trigger);
    const catalog = catalogAction(run.action);
    const required = stricterRole(minimumRoleFor(catalog?.risk), trigger?.role);
    if (!isPlatformStaff(p) && !p.memberships.some((m) => m.tenantId === instance.tenantId && roleAtLeast(m.role, required))) {
      throw new AppError(403, 'ACTION_ROLE_REQUIRED', `Approving "${run.trigger}" needs the ${required} role or higher.`);
    }
    const row = await this.prisma.instanceResource.findUnique({ where: { instanceId_resourceId: { instanceId: id, resourceId: run.resourceId } } });
    const adapter = row && this.adapters.registry.has(row.provider) ? this.adapters.registry.get(row.provider) : undefined;
    const provided = row && adapter?.actions ? resolveAction(run.action, row.type, row.provider, adapter.actions(row.capability)) : undefined;
    const platform = row && !provided ? this.platformAction(run.action, row) : undefined;
    const claimed = await this.prisma.triggerRun.updateMany({
      where: { id: runId, status: 'AWAITING_APPROVAL' },
      data: { status: 'QUEUED', approvedById: p.userId, approvedAt: new Date() },
    });
    if (claimed.count === 0) throw conflict('NOT_AWAITING_APPROVAL', 'This trigger run is not waiting for approval.');
    await this.audit.record({ principal: p, tenantId: instance.tenantId, resourceType: 'TriggerRun', resourceId: runId, action: 'APPROVE', correlationId, changes: { trigger: run.trigger, action: run.action } });
    const approved = await this.prisma.triggerRun.findUniqueOrThrow({ where: { id: runId } });
    if (platform?.ok) return toTriggerRunDto(await this.runPlatform(approved, platform.action, instance, p, correlationId));
    await this.queues.enqueueTrigger(runId);
    return toTriggerRunDto(approved);
  }

  @Scope('instances:deploy')
  @Post(':id/trigger-runs/:runId/cancel')
  @HttpCode(200)
  async cancel(
    @CurrentPrincipal() p: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('runId', ParseUUIDPipe) runId: string,
    @CorrelationId() correlationId: string,
  ): Promise<TriggerRunDto> {
    const instance = await this.load(p, id, 'deploy');
    const run = await this.prisma.triggerRun.findFirst({ where: { id: runId, instanceId: id } });
    if (!run) throw notFound('Trigger run');
    const cancelled = await this.prisma.triggerRun.updateMany({
      where: { id: runId, status: 'AWAITING_APPROVAL' },
      data: { status: 'CANCELLED', finishedAt: new Date(), message: `Cancelled by ${p.email}.` },
    });
    if (cancelled.count === 0) throw conflict('NOT_AWAITING_APPROVAL', 'Only a trigger run waiting for approval can be cancelled.');
    await this.audit.record({ principal: p, tenantId: instance.tenantId, resourceType: 'TriggerRun', resourceId: runId, action: 'CANCEL', correlationId, changes: { trigger: run.trigger } });
    return toTriggerRunDto(await this.prisma.triggerRun.findUniqueOrThrow({ where: { id: runId } }));
  }

  /**
   * A release action OrkStage runs itself (ADR 0009): a canary or blue/green release of the pending
   * changes, or a rollback to an earlier deployment. Unavailable for canary and blue/green when the
   * provider does not support them.
   */
  private platformAction(name: string, row: { type: string; provider: CloudProvider; capability: string }): { ok: true; action: CatalogAction } | { ok: false; action: CatalogAction; reason: string } | undefined {
    const action = catalogAction(name);
    if (!action?.platform || !action.resourceTypes.includes(row.type)) return undefined;
    if (action.id === 'release.rollback') return { ok: true, action };
    const strategy = action.id === 'release.canary' ? 'canary' : 'blueGreen';
    const adapter = this.adapters.registry.has(row.provider) ? this.adapters.registry.get(row.provider) : undefined;
    if (!adapter?.releaseStrategies?.(row.capability).includes(strategy)) {
      return { ok: false, action, reason: `${row.provider} does not offer ${strategy === 'canary' ? 'canary' : 'blue/green'} releases for ${row.capability} yet.` };
    }
    return { ok: true, action };
  }

  /** Starts the deployment a platform action stands for and records the outcome on the run. */
  private async runPlatform(run: TriggerRun, action: CatalogAction, instance: Instance & { templateVersion: TemplateVersion }, p: RequestPrincipal, correlationId: string): Promise<TriggerRun> {
    await this.prisma.triggerRun.update({ where: { id: run.id }, data: { status: 'RUNNING', startedAt: new Date() } });
    const params = run.params as Record<string, string | number | boolean>;
    try {
      const deployment =
        action.id === 'release.rollback'
          ? await this.launcher.rollback(instance, p, correlationId, typeof params.deployment === 'string' && params.deployment ? params.deployment : undefined)
          : (
              await this.launcher.apply(
                instance,
                p,
                correlationId,
                undefined,
                {
                  strategy: action.id === 'release.canary' ? 'canary' : 'blueGreen',
                  trafficPercent: typeof params.trafficPercent === 'number' ? params.trafficPercent : undefined,
                  bakeMinutes: typeof params.bakeMinutes === 'number' ? params.bakeMinutes : undefined,
                },
                { releaseOnly: true },
              )
            ).deployment;
      const what = action.id === 'release.rollback' ? 'Rollback' : action.id === 'release.canary' ? 'Canary release' : 'Blue/green release';
      return await this.prisma.triggerRun.update({
        where: { id: run.id },
        data: { status: 'SUCCEEDED', finishedAt: new Date(), reference: deployment.id, url: `/deployments/${deployment.id}`, message: `${what} started as a deployment.` },
      });
    } catch (err) {
      const e = err as { message?: string; code?: string };
      await this.prisma.triggerRun.update({ where: { id: run.id }, data: { status: 'FAILED', finishedAt: new Date(), message: (e.message ?? 'Failed.').slice(0, 500), errorClass: e.code ?? 'UNKNOWN' } });
      throw err;
    }
  }

  private async load(p: RequestPrincipal, id: string, action: 'read' | 'deploy') {
    const instance = await this.prisma.instance.findFirst({ where: { id, ...tenantScope(p) }, include: { templateVersion: true } });
    if (!instance) throw notFound('Instance');
    authorize(p, action, 'Instance', { tenantId: instance.tenantId });
    return instance;
  }

  private triggersOf(document: unknown): TemplateTrigger[] {
    const parsed = environmentTemplate.safeParse(document);
    return parsed.success ? parsed.data.spec.triggers : [];
  }
}

/** A catalog action as an action descriptor, for the parameter checks triggers share. */
function descriptorOf(action: CatalogAction): ResourceActionDescriptor {
  return { name: action.id, description: action.description, params: action.params.map((p) => ({ ...p })) };
}

/** Ranges the release actions accept (the catalog types only say "number"). */
function platformParamProblem(action: CatalogAction, params: Record<string, string | number | boolean>): string | null {
  const whole = (v: unknown, min: number, max: number) => v === undefined || (typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max);
  if (!whole(params.trafficPercent, 1, 50)) return 'trafficPercent must be a whole number from 1 to 50.';
  if (!whole(params.bakeMinutes, 1, 240)) return 'bakeMinutes must be a whole number from 1 to 240.';
  if (action.id === 'release.rollback' && params.deployment !== undefined && !/^[0-9a-f-]{36}$/i.test(String(params.deployment))) return 'deployment must be an OrkStage deployment id.';
  return null;
}
