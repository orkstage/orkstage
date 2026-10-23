// SPDX-License-Identifier: AGPL-3.0-only
import { listQuerySchema, runTriggerSchema, type ListQuery, type TriggerDto, type TriggerRunDto } from '@orkstage/contracts';
import type { PrismaClient, TriggerRun } from '@orkstage/database';
import { resolveTriggerParams, triggerAllows } from '@orkstage/provisioning';
import { environmentTemplate, type TemplateTrigger } from '@orkstage/templates';
import { Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { AuditService } from '../common/audit.service.js';
import { authorize, CorrelationId, CurrentPrincipal, Scope, tenantScope } from '../common/auth.js';
import { AppError, notFound, unprocessable } from '../common/errors.js';
import { page } from '../common/pagination.js';
import { ApiZodBody, ZodBody, ZodQuery } from '../common/validation.js';
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
      const descriptor = row ? adapter?.actions?.(row.capability).find((a) => a.name === t.action) : undefined;
      const reason = !row ? 'The resource is not deployed.' : !descriptor ? `${row.provider} does not offer "${t.action}" for ${row.capability}.` : null;
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
        actionParams: descriptor?.params ?? [],
        provider: row?.provider ?? null,
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
    const descriptor = adapter?.actions?.(row.capability).find((a) => a.name === trigger.action);
    if (!descriptor) throw unprocessable('ACTION_UNAVAILABLE', `${row.provider} does not offer "${trigger.action}" for ${row.capability}.`);
    const resolved = resolveTriggerParams(trigger, body.params, descriptor);
    if (!resolved.ok) throw unprocessable('INVALID_TRIGGER_PARAMS', resolved.errors[0]!, { errors: resolved.errors });

    const run = await this.prisma.triggerRun.create({
      data: {
        tenantId: instance.tenantId,
        instanceId: id,
        trigger: name,
        resourceId: trigger.resource,
        action: trigger.action,
        params: resolved.params,
        source,
        requestedById: p.apiKey ? null : p.userId,
        apiKeyId: p.apiKey?.id ?? null,
        correlationId: correlationId || randomUUID(),
      },
    });
    await this.queues.enqueueTrigger(run.id);
    await this.audit.record({ principal: p, tenantId: instance.tenantId, resourceType: 'TriggerRun', resourceId: run.id, action: 'RUN_TRIGGER', correlationId, changes: { instanceId: id, trigger: name, params: resolved.params } });
    return toTriggerRunDto(run);
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
