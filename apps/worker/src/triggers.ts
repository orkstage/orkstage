// SPDX-License-Identifier: AGPL-3.0-only
import type { ResourceOutputs } from '@orkstage/cloud-core';
import type { TriggerJob } from '@orkstage/contracts';
import { resolveAction, resolveTriggerParams, triggerAllows, triggerSchedulerId } from '@orkstage/provisioning';
import { toCloudTarget } from '@orkstage/runtime';
import { environmentTemplate, type TemplateTrigger } from '@orkstage/templates';
import type { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { notify, systemAudit, type WorkerContext } from './context.js';

/** Instance states in which actions on live resources make sense. */
const RUNNABLE = new Set(['READY', 'DEGRADED']);

/**
 * Runs template triggers (redeploy a frontend, restart a service, purge a cache) through the
 * owning adapter's `runAction`, and keeps one cron scheduler per scheduled trigger in sync with
 * the instance's current template version.
 */
export class TriggerRunner {
  constructor(
    private readonly ctx: WorkerContext,
    private readonly queue: Queue<TriggerJob>,
  ) {}

  async handle(job: TriggerJob): Promise<void> {
    const runId = 'runId' in job ? job.runId : await this.scheduledRun(job.instanceId, job.trigger);
    if (runId) await this.execute(runId);
  }

  /** Creates the run record for a cron firing, or returns null when the trigger no longer applies. */
  private async scheduledRun(instanceId: string, name: string): Promise<string | null> {
    const instance = await this.ctx.prisma.instance.findUnique({ where: { id: instanceId }, include: { templateVersion: true } });
    const trigger = instance && this.triggers(instance.templateVersion.document).find((t) => t.name === name);
    if (!instance || !trigger || !triggerAllows(trigger, 'SCHEDULE')) {
      await this.queue.removeJobScheduler(triggerSchedulerId(instanceId, name));
      return null;
    }
    if (!RUNNABLE.has(instance.status)) return null;
    const resolved = resolveTriggerParams(trigger, {});
    const run = await this.ctx.prisma.triggerRun.create({
      data: {
        tenantId: instance.tenantId,
        instanceId,
        trigger: name,
        resourceId: trigger.resource,
        action: trigger.action,
        params: resolved.ok ? resolved.params : trigger.params,
        source: 'SCHEDULE',
        correlationId: randomUUID(),
      },
    });
    return run.id;
  }

  private async execute(runId: string): Promise<void> {
    const { prisma, registry } = this.ctx;
    const run = await prisma.triggerRun.findUnique({ where: { id: runId } });
    if (run?.status !== 'QUEUED') return; // already handled (duplicate delivery)
    await prisma.triggerRun.update({ where: { id: run.id }, data: { status: 'RUNNING', startedAt: new Date() } });

    const finish = async (ok: boolean, data: { message: string; reference?: string; url?: string; errorClass?: string }) => {
      await prisma.triggerRun.update({ where: { id: run.id }, data: { ...data, status: ok ? 'SUCCEEDED' : 'FAILED', finishedAt: new Date() } });
      await systemAudit(this.ctx, { tenantId: run.tenantId, resourceType: 'TriggerRun', resourceId: run.id, action: ok ? 'TRIGGER_SUCCEEDED' : 'TRIGGER_FAILED', correlationId: run.correlationId, changes: { trigger: run.trigger, action: run.action } });
      await notify(this.ctx, {
        tenantId: run.tenantId,
        event: ok ? 'trigger.succeeded' : 'trigger.failed',
        title: ok ? `${run.trigger} started` : `${run.trigger} failed`,
        body: data.message,
        link: `/instances/${run.instanceId}`,
        data: { instanceId: run.instanceId, triggerRunId: run.id, trigger: run.trigger, action: run.action, status: ok ? 'SUCCEEDED' : 'FAILED' },
      });
    };

    const row = await prisma.instanceResource.findUnique({ where: { instanceId_resourceId: { instanceId: run.instanceId, resourceId: run.resourceId } } });
    if (row?.status !== 'ACTIVE') return finish(false, { message: `Resource "${run.resourceId}" is not deployed.`, errorClass: 'VALIDATION_ERROR' });
    const adapter = registry.has(row.provider) ? registry.get(row.provider) : undefined;
    // The run keeps the template's name (a catalog id or the provider's own); the provider gets its own.
    const action = adapter?.runAction && adapter.actions ? resolveAction(run.action, row.type, row.provider, adapter.actions(row.capability)) : undefined;
    if (!adapter?.runAction || !action) {
      return finish(false, { message: `${row.provider} does not offer "${run.action}" for ${row.capability}.`, errorClass: 'VALIDATION_ERROR' });
    }
    // A scheduled disruptive action on production waits for a person, like one started by hand (ADR 0009).
    const instance = await prisma.instance.findUniqueOrThrow({ where: { id: run.instanceId }, select: { environment: true, name: true } });
    if (!run.approvedAt && instance.environment === 'production' && (action.catalog?.risk ?? 'disruptive') !== 'safe') {
      await prisma.triggerRun.update({ where: { id: run.id }, data: { status: 'AWAITING_APPROVAL', startedAt: null } });
      await notify(this.ctx, {
        tenantId: run.tenantId,
        event: 'trigger.awaiting_approval',
        title: `${run.trigger} awaits approval`,
        body: `${run.action} on the production instance ${instance.name} needs approval before it runs.`,
        link: `/instances/${run.instanceId}`,
        data: { instanceId: run.instanceId, triggerRunId: run.id, trigger: run.trigger, action: run.action, status: 'AWAITING_APPROVAL' },
      });
      return;
    }
    const target = await prisma.cloudTarget.findUniqueOrThrow({ where: { id: row.targetId } });
    try {
      const result = await adapter.runAction(
        { target: toCloudTarget(target), region: row.region, correlationId: run.correlationId },
        {
          resourceId: row.resourceId,
          serviceKind: row.type,
          capability: row.capability,
          name: row.name,
          providerResourceId: row.providerResourceId ?? undefined,
          outputs: (row.outputs ?? undefined) as ResourceOutputs | undefined,
        },
        { action: action.descriptor.name, params: run.params as Record<string, string | number | boolean> },
      );
      await finish(true, { message: result.message, reference: result.reference, url: result.url });
    } catch (err) {
      const e = err as { message?: string; failureClass?: string };
      await finish(false, { message: (e.message ?? 'Action failed.').slice(0, 500), errorClass: e.failureClass ?? 'UNKNOWN' });
    }
  }

  /**
   * One cron scheduler per scheduled trigger of the instance's current template version (UTC).
   * Called after every apply and destroy, so removed or changed schedules never keep firing.
   */
  async syncSchedules(instanceId: string): Promise<void> {
    const instance = await this.ctx.prisma.instance.findUnique({ where: { id: instanceId }, include: { templateVersion: true } });
    const wanted = new Map<string, string>();
    if (instance && instance.status !== 'DESTROYED') {
      for (const t of this.triggers(instance.templateVersion.document)) {
        if (t.on.schedule) wanted.set(triggerSchedulerId(instanceId, t.name), t.on.schedule);
      }
    }
    const prefix = triggerSchedulerId(instanceId, '');
    for (const s of await this.queue.getJobSchedulers()) {
      if (s.key.startsWith(prefix) && !wanted.has(s.key)) await this.queue.removeJobScheduler(s.key);
    }
    for (const [id, pattern] of wanted) {
      const trigger = id.slice(prefix.length);
      await this.queue.upsertJobScheduler(id, { pattern, tz: 'UTC' }, { name: 'scheduled', data: { instanceId, trigger } });
    }
  }

  private triggers(document: unknown): TemplateTrigger[] {
    const parsed = environmentTemplate.safeParse(document);
    return parsed.success ? parsed.data.spec.triggers : [];
  }
}
