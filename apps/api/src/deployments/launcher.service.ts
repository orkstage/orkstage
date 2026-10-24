// SPDX-License-Identifier: AGPL-3.0-only
import type { DeploymentSummaryDto } from '@orkstage/contracts';
import type { Deployment, Instance, InstanceStatus, PrismaClient } from '@orkstage/database';
import { canStartDeployment, canStartDestroy, operationKey, releaseSettings, type ReleaseSettings } from '@orkstage/domain';
import { diffPlan, requiresApproval, type ResolvedInfrastructure, type WorkflowKind } from '@orkstage/provisioning';
import { DEPLOYABLE, InstanceBusyError, recordDeployment, recordRollback, rollbackTarget } from '@orkstage/runtime';
import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../common/audit.service.js';
import { conflict, unprocessable } from '../common/errors.js';
import { iso } from '../common/pagination.js';
import { Adapters, PRISMA, Queues } from '../infra/infra.module.js';
import { CompileService } from '../instances/compile.service.js';
import type { RequestPrincipal } from '../types.js';

const DESTROYABLE: InstanceStatus[] = ['READY', 'DEGRADED', 'VALIDATION_FAILED', 'PLAN_FAILED', 'PROVISION_FAILED', 'DEPLOY_FAILED', 'VERIFICATION_FAILED', 'DESTROY_FAILED'];

export function toDeploymentSummary(d: Deployment): DeploymentSummaryDto {
  return {
    id: d.id,
    instanceId: d.instanceId,
    tenantId: d.tenantId,
    kind: d.kind,
    status: d.status,
    simulated: d.simulated,
    correlationId: d.correlationId,
    queuedAt: d.queuedAt.toISOString(),
    startedAt: iso(d.startedAt),
    finishedAt: iso(d.finishedAt),
    errorClass: d.errorClass,
    errorMessage: d.errorMessage,
    release: (d.release as DeploymentSummaryDto['release']) ?? null,
    bakeUntil: iso(d.bakeUntil),
    verifiedAt: iso(d.verifiedAt),
    bakeFailedAt: iso(d.bakeFailedAt),
    bakeFailure: d.bakeFailure,
    rollbackToId: d.rollbackToId,
  };
}

/**
 * Creates deployments. HTTP requests only validate, record intent and enqueue; all cloud work
 * happens in the worker (spec §16). The instance status is moved with a compare-and-set, so two
 * concurrent requests can never start two deployments on one instance (spec §36).
 */
@Injectable()
export class LauncherService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly compiler: CompileService,
    private readonly queues: Queues,
    private readonly audit: AuditService,
    private readonly adapters: Adapters,
  ) {}

  /**
   * Starts an apply. `templateVersionId` deploys another version of the instance's template (an
   * upgrade or a rollback); the instance moves to it only when the apply succeeds.
   */
  async apply(
    instance: Instance,
    p: RequestPrincipal,
    correlationId: string,
    templateVersionId = instance.templateVersionId,
    release: Partial<ReleaseSettings> = {},
    opts: { releaseOnly?: boolean } = {},
  ): Promise<{ deployment: Deployment; reused: boolean }> {
    if (instance.status === 'DESTROYED') {
      throw conflict('INSTANCE_DESTROYED', 'This instance has been destroyed. Create a new instance to deploy again.');
    }
    if (!canStartDeployment(instance.status)) {
      throw conflict('INSTANCE_BUSY', `Instance is ${instance.status}; wait for the current operation to finish.`);
    }
    const resolved = await this.compiler.compile({
      tenantId: instance.tenantId,
      instanceId: instance.id,
      instanceSlug: instance.slug,
      environment: instance.environment,
      templateVersionId,
      variables: instance.variables as Record<string, string | number | boolean>,
      bindings: instance.bindings as Record<string, { targetId: string; region: string }>,
    });
    if (!resolved.valid) {
      await this.audit.record({ principal: p, tenantId: instance.tenantId, resourceType: 'Instance', resourceId: instance.id, action: 'DEPLOY', result: 'FAILURE', correlationId, changes: { reason: 'validation', issues: resolved.issues.length } });
      throw unprocessable('VALIDATION_FAILED', 'The instance configuration is not deployable. Fix the issues and retry.', { issues: resolved.issues });
    }

    const opKey = operationKey(instance.tenantId, instance.id, resolved.desiredStateHash);
    const active = await this.prisma.deployment.findFirst({
      where: { operationKey: opKey, status: { in: ['QUEUED', 'RUNNING', 'AWAITING_APPROVAL'] } },
    });
    if (active) return { deployment: active, reused: true };

    const settings = releaseSettings(resolved.release, release);
    this.checkStrategy(resolved, settings);
    const plan = diffPlan(resolved, await this.compiler.knownResources(instance.id));
    if (opts.releaseOnly && !plan.changes.some((c) => c.type === 'compute.container-service' && (c.action === 'CREATE' || c.action === 'UPDATE'))) {
      throw unprocessable('NOTHING_TO_RELEASE', 'No container service changes since the last deployment: there is nothing to release.');
    }
    const approvalRequired = requiresApproval(instance.environment, plan);
    const deployment = await this.create('APPLY', instance, resolved, { opKey, plan, approvalRequired, p, correlationId, deployable: DEPLOYABLE, templateVersionId, release: settings });
    await this.audit.record({
      principal: p,
      tenantId: instance.tenantId,
      resourceType: 'Instance',
      resourceId: instance.id,
      action: 'DEPLOY',
      correlationId,
      changes: { deploymentId: deployment.id, plan: plan.counts, risk: plan.risk, approvalRequired, release: settings.strategy, bakeMinutes: settings.bakeMinutes },
    });
    return { deployment, reused: false };
  }

  /**
   * Returns the instance to an earlier deployment's configuration (ADR 0009): the one asked for, or
   * the last that stayed healthy through its bake period.
   */
  async rollback(instance: Instance, p: RequestPrincipal, correlationId: string, deploymentId?: string): Promise<Deployment> {
    if (instance.status === 'DESTROYED') throw conflict('INSTANCE_DESTROYED', 'This instance has been destroyed.');
    if (!canStartDeployment(instance.status)) throw conflict('INSTANCE_BUSY', `Instance is ${instance.status}; wait for the current operation to finish.`);
    const latest = await this.prisma.deployment.findFirst({ where: { instanceId: instance.id, kind: 'APPLY', status: 'SUCCEEDED' }, orderBy: { queuedAt: 'desc' } });
    const target = await rollbackTarget(this.prisma, instance.id, { deploymentId, before: latest?.queuedAt ?? new Date() });
    if (!target.ok) throw unprocessable('NO_ROLLBACK_TARGET', target.reason);
    if (latest?.id === target.deployment.id) throw unprocessable('NO_ROLLBACK_TARGET', 'The instance already runs that deployment.');
    let deployment: Deployment;
    try {
      deployment = await recordRollback(this.prisma, { instance, target: target.deployment, requestedById: p.userId, requestedBy: p.email, correlationId });
    } catch (err) {
      if (err instanceof InstanceBusyError) throw conflict('INSTANCE_BUSY', err.message);
      throw err;
    }
    await this.queues.enqueueDeployment(deployment.id);
    await this.audit.record({ principal: p, tenantId: instance.tenantId, resourceType: 'Instance', resourceId: instance.id, action: 'ROLLBACK', correlationId, changes: { deploymentId: deployment.id, to: target.deployment.id } });
    return deployment;
  }

  /** A canary or blue/green release needs a provider that offers it for every container service. */
  private checkStrategy(resolved: ResolvedInfrastructure, release: ReleaseSettings): void {
    if (release.strategy === 'rolling') return;
    for (const r of resolved.resources.filter((x) => x.type === 'compute.container-service')) {
      const adapter = this.adapters.registry.has(r.provider) ? this.adapters.registry.get(r.provider) : undefined;
      const strategies = adapter?.releaseStrategies?.(r.capability) ?? [];
      if (!strategies.includes(release.strategy)) {
        throw unprocessable('RELEASE_STRATEGY_UNSUPPORTED', `${r.provider} does not offer ${release.strategy === 'canary' ? 'canary' : 'blue/green'} releases for ${r.capability} (service ${r.id}) yet. Deploy with the rolling strategy.`);
      }
    }
  }

  async destroy(instance: Instance, p: RequestPrincipal, correlationId: string): Promise<Deployment> {
    if (!canStartDestroy(instance.status)) throw conflict('INSTANCE_BUSY', `Instance is ${instance.status} and cannot be destroyed now.`);
    if (instance.protectedFromDestroy) throw unprocessable('DESTROY_PROTECTED', 'This instance is protected from destruction. Remove the protection first.');

    // Destroy what is known to exist, using the dependency graph of the last applied snapshot.
    const last = await this.prisma.deployment.findFirst({
      where: { instanceId: instance.id, kind: 'APPLY' },
      orderBy: { queuedAt: 'desc' },
    });
    const known = await this.prisma.instanceResource.findMany({ where: { instanceId: instance.id, status: { in: ['ACTIVE', 'FAILED'] } } });
    const snapshot = (last?.resolved ?? null) as ResolvedInfrastructure | null;
    const keep = new Set(known.map((k) => k.resourceId));
    const resources = (snapshot?.resources ?? []).filter((r) => keep.has(r.id)).map((r) => ({ ...r, dependsOn: r.dependsOn.filter((d) => keep.has(d)) }));
    const levels = (snapshot?.levels ?? []).map((l) => l.filter((id) => keep.has(id))).filter((l) => l.length > 0);
    const resolved: ResolvedInfrastructure = {
      ...(snapshot ?? emptyResolved(instance)),
      resources,
      levels,
    };

    const opKey = operationKey(instance.tenantId, instance.id, `destroy:${Date.now()}`);
    // Destroying production deletes customer data: it waits for an explicit approval (spec §62).
    const deployment = await this.create('DESTROY', instance, resolved, { opKey, plan: null, approvalRequired: instance.environment === 'production', p, correlationId, deployable: DESTROYABLE });
    await this.audit.record({ principal: p, tenantId: instance.tenantId, resourceType: 'Instance', resourceId: instance.id, action: 'DESTROY', correlationId, changes: { deploymentId: deployment.id, resources: resources.length } });
    return deployment;
  }

  /** Re-runs only the resources that failed or were skipped, from the same snapshot. */
  async retry(previous: Deployment, p: RequestPrincipal, correlationId: string): Promise<Deployment> {
    if (!['FAILED', 'PARTIALLY_FAILED'].includes(previous.status)) throw conflict('NOT_RETRYABLE', 'Only failed deployments can be retried.');
    const latest = await this.prisma.deployment.findFirst({ where: { instanceId: previous.instanceId }, orderBy: { queuedAt: 'desc' } });
    if (latest?.id !== previous.id) throw conflict('NOT_LATEST', 'A newer deployment exists for this instance.');
    const instance = await this.prisma.instance.findUniqueOrThrow({ where: { id: previous.instanceId } });
    const steps = await this.prisma.deploymentStep.findMany({ where: { deploymentId: previous.id, kind: 'RESOURCE', status: { in: ['FAILED', 'SKIPPED', 'CANCELLED', 'PENDING'] } } });
    const resolved = previous.resolved as unknown as ResolvedInfrastructure;
    const deployment = await this.create(previous.kind, instance, resolved, {
      opKey: `${previous.operationKey}:retry:${Date.now()}`,
      plan: previous.plan,
      approvalRequired: false,
      p,
      correlationId,
      deployable: previous.kind === 'APPLY' ? DEPLOYABLE : DESTROYABLE,
      onlyResources: steps.map((s) => s.key),
      retryOfId: previous.id,
      templateVersionId: previous.templateVersionId,
    });
    await this.audit.record({ principal: p, tenantId: instance.tenantId, resourceType: 'Deployment', resourceId: previous.id, action: 'RETRY', correlationId, changes: { deploymentId: deployment.id, resources: steps.map((s) => s.key) } });
    return deployment;
  }

  private async create(
    kind: WorkflowKind,
    instance: Instance,
    resolved: ResolvedInfrastructure,
    o: {
      opKey: string;
      plan: unknown;
      approvalRequired: boolean;
      p: RequestPrincipal;
      correlationId: string;
      deployable: InstanceStatus[];
      onlyResources?: string[];
      retryOfId?: string;
      templateVersionId?: string;
      release?: ReleaseSettings;
    },
  ): Promise<Deployment> {
    let deployment: Deployment;
    try {
      deployment = await recordDeployment(this.prisma, {
        kind,
        instance,
        resolved,
        opKey: o.opKey,
        plan: o.plan,
        approvalRequired: o.approvalRequired,
        requestedById: o.p.userId,
        requestedBy: o.p.email,
        correlationId: o.correlationId,
        deployable: o.deployable,
        onlyResources: o.onlyResources,
        retryOfId: o.retryOfId,
        templateVersionId: o.templateVersionId,
        release: o.release,
      });
    } catch (err) {
      if (err instanceof InstanceBusyError) throw conflict('INSTANCE_BUSY', err.message);
      throw err;
    }
    await this.queues.enqueueDeployment(deployment.id);
    return deployment;
  }
}

function emptyResolved(instance: Instance): ResolvedInfrastructure {
  return {
    template: { name: '', version: '' },
    environment: instance.environment as ResolvedInfrastructure['environment'],
    resources: [],
    levels: [],
    connectivity: [],
    targets: {},
    policyResults: [],
    issues: [],
    cost: { currency: 'USD', period: 'monthly', total: 0, confidence: 'unavailable', lines: [] },
    desiredStateHash: '',
    valid: true,
  };
}
