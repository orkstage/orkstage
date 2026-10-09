import type { DeploymentSummaryDto } from '@orkstage/contracts';
import type { Deployment, Instance, InstanceStatus, PrismaClient } from '@orkstage/database';
import { canStartDeployment, canStartDestroy, operationKey } from '@orkstage/domain';
import { diffPlan, requiresApproval, workflowSteps, type ResolvedInfrastructure, type WorkflowKind } from '@orkstage/provisioning';
import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../common/audit.service.js';
import { conflict, unprocessable } from '../common/errors.js';
import { iso } from '../common/pagination.js';
import { PRISMA, Queues } from '../infra/infra.module.js';
import { CompileService } from '../instances/compile.service.js';
import type { RequestPrincipal } from '../types.js';

const DEPLOYABLE: InstanceStatus[] = ['DRAFT', 'READY', 'DEGRADED', 'VALIDATION_FAILED', 'PLAN_FAILED', 'PROVISION_FAILED', 'DEPLOY_FAILED', 'VERIFICATION_FAILED'];
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
  ) {}

  async apply(instance: Instance, p: RequestPrincipal, correlationId: string): Promise<{ deployment: Deployment; reused: boolean }> {
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
      templateVersionId: instance.templateVersionId,
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

    const plan = diffPlan(resolved, await this.compiler.knownResources(instance.id));
    const approvalRequired = requiresApproval(instance.environment, plan);
    const deployment = await this.create('APPLY', instance, resolved, { opKey, plan, approvalRequired, p, correlationId, deployable: DEPLOYABLE });
    await this.audit.record({ principal: p, tenantId: instance.tenantId, resourceType: 'Instance', resourceId: instance.id, action: 'DEPLOY', correlationId, changes: { deploymentId: deployment.id, plan: plan.counts, risk: plan.risk, approvalRequired } });
    return { deployment, reused: false };
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
    const deployment = await this.create('DESTROY', instance, resolved, { opKey, plan: null, approvalRequired: false, p, correlationId, deployable: DESTROYABLE });
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
    },
  ): Promise<Deployment> {
    const nextStatus: InstanceStatus = kind === 'APPLY' ? 'VALIDATING' : 'DESTROYING';
    // Production applies always carry an approval step: the worker may escalate to it when the
    // provider plan turns out destructive, or marks it skipped with the reason.
    const steps = workflowSteps(kind, resolved, o.approvalRequired || (kind === 'APPLY' && instance.environment === 'production'));
    const deployment = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.instance.updateMany({
        where: { id: instance.id, status: { in: o.deployable } },
        data: { status: nextStatus },
      });
      if (claimed.count === 0) throw conflict('INSTANCE_BUSY', 'Another operation started on this instance. Refresh and try again.');
      const d = await tx.deployment.create({
        data: {
          tenantId: instance.tenantId,
          instanceId: instance.id,
          kind,
          templateVersionId: instance.templateVersionId,
          requestedById: o.p.userId,
          correlationId: o.correlationId,
          operationKey: o.opKey,
          simulated: resolved.resources.length > 0 && resolved.resources.every((r) => r.provider === 'mock'),
          approvalRequired: o.approvalRequired,
          resolved: resolved as object,
          plan: (o.plan ?? undefined) as object | undefined,
          cost: resolved.cost as object,
          onlyResources: o.onlyResources ?? [],
          retryOfId: o.retryOfId,
          steps: { create: steps.map((s) => ({ key: s.key, kind: s.kind, name: s.name, position: s.position, provider: s.provider, region: s.region })) },
          events: { create: { level: 'info', message: `${kind === 'APPLY' ? 'Deployment' : 'Destroy'} requested by ${o.p.email}.` } },
        },
      });
      await tx.instanceTransition.create({
        data: { instanceId: instance.id, tenantId: instance.tenantId, from: instance.status, to: nextStatus, deploymentId: d.id, reason: `${kind} requested` },
      });
      return d;
    });
    await this.queues.enqueueDeployment(deployment.id);
    return deployment;
  }
}

function emptyResolved(instance: Instance): ResolvedInfrastructure {
  return {
    template: { name: '', version: '' },
    plan: 'FREE',
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
