// SPDX-License-Identifier: AGPL-3.0-only
import type { Deployment, Instance, InstanceStatus, PrismaClient } from '@orkstage/database';
import { DEFAULT_RELEASE, operationKey, type ReleaseSettings } from '@orkstage/domain';
import { diffPlan, type KnownResource, requiresApproval, type ResolvedInfrastructure, type WorkflowKind, workflowSteps } from '@orkstage/provisioning';

/** Another operation holds the instance. */
export class InstanceBusyError extends Error {
  constructor(message = 'Another operation started on this instance. Refresh and try again.') {
    super(message);
    this.name = 'InstanceBusyError';
  }
}

/** Instance states an apply (and so a rollback) may start from. */
export const DEPLOYABLE: InstanceStatus[] = ['DRAFT', 'READY', 'DEGRADED', 'VALIDATION_FAILED', 'PLAN_FAILED', 'PROVISION_FAILED', 'DEPLOY_FAILED', 'VERIFICATION_FAILED'];

export interface NewDeployment {
  kind: WorkflowKind;
  instance: Instance;
  resolved: ResolvedInfrastructure;
  opKey: string;
  plan: unknown;
  approvalRequired: boolean;
  requestedById: string | null;
  /** Who asked, for the first event ("requested by ..."). */
  requestedBy: string;
  correlationId: string;
  deployable: InstanceStatus[];
  onlyResources?: string[];
  retryOfId?: string;
  templateVersionId?: string;
  release?: ReleaseSettings;
  rollbackToId?: string;
}

/**
 * Claims the instance and records a deployment with its steps. The caller queues it. Throws
 * InstanceBusyError when the instance is not in one of `deployable`.
 */
export async function recordDeployment(prisma: PrismaClient, n: NewDeployment): Promise<Deployment> {
  const nextStatus: InstanceStatus = n.kind === 'APPLY' ? 'VALIDATING' : 'DESTROYING';
  // Production applies always carry an approval step: the worker may escalate to it when the
  // provider plan turns out destructive, or marks it skipped with the reason.
  const steps = workflowSteps(n.kind, n.resolved, n.approvalRequired || (n.kind === 'APPLY' && n.instance.environment === 'production'));
  const what = n.rollbackToId ? 'Rollback' : n.kind === 'APPLY' ? 'Deployment' : 'Destroy';
  return prisma.$transaction(async (tx) => {
    const claimed = await tx.instance.updateMany({ where: { id: n.instance.id, status: { in: n.deployable } }, data: { status: nextStatus } });
    if (claimed.count === 0) throw new InstanceBusyError();
    const d = await tx.deployment.create({
      data: {
        tenantId: n.instance.tenantId,
        instanceId: n.instance.id,
        kind: n.kind,
        templateVersionId: n.templateVersionId ?? n.instance.templateVersionId,
        requestedById: n.requestedById,
        correlationId: n.correlationId,
        operationKey: n.opKey,
        simulated: n.resolved.resources.length > 0 && n.resolved.resources.every((r) => r.provider === 'mock'),
        approvalRequired: n.approvalRequired,
        resolved: n.resolved as object,
        plan: (n.plan ?? undefined) as object | undefined,
        cost: n.resolved.cost as object,
        onlyResources: n.onlyResources ?? [],
        retryOfId: n.retryOfId,
        release: n.kind === 'APPLY' ? ((n.release ?? DEFAULT_RELEASE) as object) : undefined,
        rollbackToId: n.rollbackToId,
        steps: { create: steps.map((s) => ({ key: s.key, kind: s.kind, name: s.name, position: s.position, provider: s.provider, region: s.region })) },
        events: { create: { level: 'info', message: `${what} requested by ${n.requestedBy}.` } },
      },
    });
    await tx.instanceTransition.create({
      data: { instanceId: n.instance.id, tenantId: n.instance.tenantId, from: n.instance.status, to: nextStatus, deploymentId: d.id, reason: `${n.rollbackToId ? 'ROLLBACK' : n.kind} requested` },
    });
    return d;
  });
}

/** Resources the platform knows for an instance, as the plan diff reads them. */
export async function knownResources(prisma: PrismaClient, instanceId: string): Promise<KnownResource[]> {
  const rows = await prisma.instanceResource.findMany({ where: { instanceId, status: { in: ['ACTIVE', 'FAILED'] } } });
  return rows.map((r) => ({
    drifted: r.drift === 'DRIFT_DETECTED',
    resourceId: r.resourceId,
    type: r.type,
    specHash: r.status === 'ACTIVE' ? r.specHash : null,
    targetId: r.targetId,
    region: r.region,
    provider: r.simulatedProvider ?? r.provider,
    capabilityName: r.capabilityName,
    name: r.name,
  }));
}

export type RollbackTargetResult = { ok: true; deployment: Deployment } | { ok: false; reason: string };

/**
 * The deployment a rollback returns to (ADR 0009): the one asked for, or else the last apply that
 * stayed healthy through its bake period before `before` (the deployment being rolled back).
 */
export async function rollbackTarget(prisma: PrismaClient, instanceId: string, opts: { deploymentId?: string; before: Date }): Promise<RollbackTargetResult> {
  if (opts.deploymentId) {
    const d = await prisma.deployment.findFirst({ where: { id: opts.deploymentId, instanceId } });
    if (!d) return { ok: false, reason: 'That deployment does not belong to this instance.' };
    if (d.kind !== 'APPLY' || d.status !== 'SUCCEEDED' || !d.resolved) return { ok: false, reason: 'Only a deployment that completed can be returned to.' };
    return { ok: true, deployment: d };
  }
  const d = await prisma.deployment.findFirst({
    where: { instanceId, kind: 'APPLY', status: 'SUCCEEDED', verifiedAt: { not: null }, queuedAt: { lt: opts.before } },
    orderBy: { queuedAt: 'desc' },
  });
  return d ? { ok: true, deployment: d } : { ok: false, reason: 'No earlier deployment stayed healthy through its bake period. Choose the deployment to return to.' };
}

/**
 * Records a rollback: an apply of the target deployment's frozen configuration (template version,
 * image digests, variables). Production approval follows the plan like any apply; database
 * migrations are not undone. The caller queues it.
 */
export async function recordRollback(
  prisma: PrismaClient,
  args: { instance: Instance; target: Deployment; requestedById: string | null; requestedBy: string; correlationId: string },
): Promise<Deployment> {
  const resolved = args.target.resolved as unknown as ResolvedInfrastructure;
  const plan = diffPlan(resolved, await knownResources(prisma, args.instance.id));
  return recordDeployment(prisma, {
    kind: 'APPLY',
    instance: args.instance,
    resolved,
    opKey: operationKey(args.instance.tenantId, args.instance.id, `rollback:${args.target.id}:${resolved.desiredStateHash}`),
    plan,
    approvalRequired: requiresApproval(args.instance.environment, plan),
    requestedById: args.requestedById,
    requestedBy: args.requestedBy,
    correlationId: args.correlationId,
    deployable: DEPLOYABLE,
    templateVersionId: args.target.templateVersionId,
    // The configuration returned to is watched again, without a canary: it ran before.
    release: { ...DEFAULT_RELEASE, bakeMinutes: ((args.target.release as ReleaseSettings | null)?.bakeMinutes ?? 0) },
    rollbackToId: args.target.id,
  });
}
