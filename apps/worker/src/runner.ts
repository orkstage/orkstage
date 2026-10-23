// SPDX-License-Identifier: AGPL-3.0-only
import type { ResourceOutputs, ResourceResult } from '@orkstage/cloud-core';
import type { Deployment, InstanceStatus, StepStatus } from '@orkstage/database';
import { assertInstanceTransition, isProviderEnabled, providerFlagKey, resolveFeatureFlags, summarizeSteps, type FailureClass } from '@orkstage/domain';
import {
  describeProviderPlan,
  diffPlan,
  executeApply,
  executeDestroy,
  idempotencyKeyFor,
  PHASE,
  previewProviderPlans,
  renderPlan,
  toFailure,
  type CompletedResources,
  type KnownResource,
  type ResolvedInfrastructure,
  type StepFailure,
} from '@orkstage/provisioning';
import { annotateSpan, platformMetrics, toCloudTarget } from '@orkstage/runtime';
import type { Logger } from 'pino';
import { notify, systemAudit, type WorkerContext } from './context.js';
import { TargetSlots } from './slots.js';
import { instanceHealth, syncStatusComponents } from './status.js';

/** Thrown to park a job (e.g. waiting for a target slot); the job is retried later. */
export class RetryLater extends Error {}

class PhaseFailure extends Error {
  constructor(
    readonly failureClass: FailureClass,
    message: string,
  ) {
    super(message);
  }
}

/** Instance states in workflow order; transitions only ever move forward within a run. */
const APPLY_ORDER: InstanceStatus[] = ['VALIDATING', 'PLANNING', 'AWAITING_APPROVAL', 'PROVISIONING', 'DEPLOYING', 'CONFIGURING', 'VERIFYING'];

const FAILED_STATE: Partial<Record<InstanceStatus, InstanceStatus>> = {
  VALIDATING: 'VALIDATION_FAILED',
  PLANNING: 'PLAN_FAILED',
  AWAITING_APPROVAL: 'PLAN_FAILED',
  PROVISIONING: 'PROVISION_FAILED',
  DEPLOYING: 'DEPLOY_FAILED',
  CONFIGURING: 'DEPLOY_FAILED',
  VERIFYING: 'VERIFICATION_FAILED',
  DESTROYING: 'DESTROY_FAILED',
};

const CANCEL_POLL_MS = 1500;
const VERIFY_SETTLE_MS = 5 * 60 * 1000;
const VERIFY_POLL_MS = 10_000;

/**
 * Executes one deployment (spec §16). Every phase and resource step is persisted before and
 * after it runs, so a restarted worker resumes where the previous one stopped: completed phases
 * are skipped and converged resources are not touched again (spec §35).
 */
export class DeploymentRunner {
  constructor(
    private readonly ctx: WorkerContext,
    private readonly slots: TargetSlots,
  ) {}

  async run(deploymentId: string): Promise<void> {
    const { prisma } = this.ctx;
    const deployment = await prisma.deployment.findUnique({ where: { id: deploymentId } });
    if (!deployment || ['SUCCEEDED', 'FAILED', 'PARTIALLY_FAILED', 'CANCELLED'].includes(deployment.status)) return;

    annotateSpan({ 'tenant.id': deployment.tenantId, 'instance.id': deployment.instanceId, 'deployment.id': deploymentId, 'deployment.kind': deployment.kind });
    const log = this.ctx.logger.child({
      tenantId: deployment.tenantId,
      instanceId: deployment.instanceId,
      deploymentId,
      correlationId: deployment.correlationId,
    });
    const resolved = deployment.resolved as unknown as ResolvedInfrastructure;
    const targetIds = Object.keys(resolved.targets);

    if (deployment.cancelRequestedAt) return this.finishCancelled(deployment, log);
    if (deployment.status === 'AWAITING_APPROVAL' && !deployment.approvedAt) return; // still parked

    const limits = Object.fromEntries(
      (await prisma.cloudTarget.findMany({ where: { id: { in: targetIds } }, select: { id: true, maxConcurrentDeployments: true } })).map((t) => [t.id, t.maxConcurrentDeployments]),
    );
    const scopes = TargetSlots.scopes({
      tenantId: deployment.tenantId,
      tenantLimit: this.ctx.config.DEPLOY_LIMIT_PER_TENANT,
      targets: limits,
      regions: resolved.resources.map((r) => ({ provider: r.provider, region: r.region })),
      regionLimit: this.ctx.config.DEPLOY_LIMIT_PER_PROVIDER_REGION,
    });
    if (!(await this.slots.acquire(deploymentId, scopes))) {
      await this.event(deploymentId, 'info', null, 'Waiting for a free deployment slot (cloud target, tenant or region limit).');
      throw new RetryLater('deployment slots busy');
    }

    try {
      await prisma.deployment.update({ where: { id: deploymentId }, data: { status: 'RUNNING', startedAt: deployment.startedAt ?? new Date() } });
      if (deployment.kind === 'APPLY') await this.apply(deployment, resolved, log);
      else await this.destroy(deployment, resolved, log);
    } catch (err) {
      if (err instanceof RetryLater) throw err;
      const f = err instanceof PhaseFailure ? { failureClass: err.failureClass, message: err.message } : toFailure(err);
      log.error({ err, failureClass: f.failureClass }, 'deployment failed');
      await this.fail(deployment, f.failureClass, f.message);
    } finally {
      await this.slots.release(deploymentId, scopes);
    }
  }

  // ───────────────────────────── APPLY ─────────────────────────────

  private async apply(d: Deployment, resolved: ResolvedInfrastructure, log: Logger) {
    const prisma = this.ctx.prisma;

    await this.phase(d, PHASE.validate, async () => {
      if (!resolved.valid) throw new PhaseFailure('VALIDATION_ERROR', `${resolved.issues.length} validation issue(s) block this deployment.`);
      const warnings = resolved.policyResults.filter((p) => p.status === 'warn');
      for (const w of warnings) await this.event(d.id, 'warn', PHASE.validate, w.message);
      return `Template ${resolved.template.name}@${resolved.template.version} valid; ${resolved.policyResults.filter((p) => p.status === 'pass').length} policies passed, ${warnings.length} warning(s).`;
    });
    await this.moveInstance(d, 'PLANNING');

    await this.phase(d, PHASE.targets, async () => {
      const regions = new Map<string, Set<string>>();
      for (const r of resolved.resources) {
        if (!regions.has(r.targetId)) regions.set(r.targetId, new Set());
        regions.get(r.targetId)!.add(r.region);
      }
      // Feature flags can change between plan and run: check again here (apply only, never destroy).
      const flags = resolveFeatureFlags(await prisma.featureFlag.findMany({ where: { OR: [{ tenantId: null }, { tenantId: d.tenantId }] } }), d.tenantId);
      for (const [targetId, rs] of regions) {
        const row = await prisma.cloudTarget.findUniqueOrThrow({ where: { id: targetId } });
        if (row.status !== 'ACTIVE') throw new PhaseFailure('VALIDATION_ERROR', `Cloud target ${row.name} is disabled.`);
        if (!isProviderEnabled(flags, row.provider)) throw new PhaseFailure('VALIDATION_ERROR', `${row.provider} is disabled on this platform (feature flag ${providerFlagKey(row.provider)}).`);
        for (const region of rs) {
          const serviceKinds = [...new Set(resolved.resources.filter((r) => r.targetId === targetId && r.region === region).map((r) => r.type))];
          const result = await this.ctx.registry.get(row.provider).validateTarget({ target: toCloudTarget(row), region, correlationId: d.correlationId }, { serviceKinds });
          await prisma.cloudTarget.update({ where: { id: targetId }, data: { lastValidation: result as object, lastValidatedAt: new Date(), health: result.ok ? 'HEALTHY' : 'UNHEALTHY' } });
          if (!result.ok && row.health !== 'UNHEALTHY') {
            await notify(this.ctx, {
              tenantId: d.tenantId,
              event: 'cloud_target.unhealthy',
              title: `Cloud target ${row.name} failed validation`,
              body: 'A deployment could not start because the cloud connection failed its checks.',
              link: `/deployments/${d.id}`,
              data: { cloudTargetId: row.id, provider: row.provider, deploymentId: d.id },
            });
          }
          if (!result.ok) {
            const failed = result.checks.filter((c) => c.status === 'error' || c.status === 'missing').map((c) => `${c.name}: ${c.message}`);
            const onlyPermissions = result.checks.filter((c) => c.status === 'error' || c.status === 'missing').every((c) => c.name.startsWith('Permissions'));
            throw new PhaseFailure(onlyPermissions ? 'AUTHORIZATION_ERROR' : 'AUTHENTICATION_ERROR', `Cloud target ${row.name} (${region}) failed validation: ${failed.join('; ')}`);
          }
          for (const c of result.checks.filter((c) => c.status === 'warn' || c.status === 'skipped')) await this.event(d.id, 'warn', PHASE.targets, `${row.name} (${region}), ${c.name}: ${c.message}`);
          await this.event(d.id, 'info', PHASE.targets, `${row.name} / ${region}: ${result.checks.filter((c) => c.status === 'ok').length} checks passed.`);
        }
      }
      return `${regions.size} cloud target(s) validated.`;
    });

    await this.phase(d, PHASE.plan, async () => {
      const plan = diffPlan(resolved, await this.known(d.instanceId));
      const text = renderPlan((await prisma.instance.findUniqueOrThrow({ where: { id: d.instanceId } })).name, plan);
      // Real provider plans for existing resources that change: catches deletions/replacements
      // the platform-level diff cannot see (e.g. an immutable attribute forcing replacement).
      const rows = await prisma.instanceResource.findMany({ where: { instanceId: d.instanceId, status: 'ACTIVE' } });
      const provider = await previewProviderPlans({
        resolved,
        registry: this.ctx.registry,
        tenantId: d.tenantId,
        instanceId: d.instanceId,
        correlationId: d.correlationId,
        planId: d.id,
        existing: Object.fromEntries(rows.map((r) => [r.resourceId, { idempotencyKey: r.idempotencyKey, outputs: r.outputs as ResourceOutputs }])),
      });
      for (const e of provider.entries) {
        await this.event(d.id, e.status === 'planned' && e.plan.destructive ? 'warn' : 'info', PHASE.plan, describeProviderPlan(e));
      }
      // Production: a delete or replace, or a resource no provider could plan, waits for a person.
      const escalate = (provider.destructive || provider.failed) && resolved.environment === 'production' && !d.approvalRequired;
      await prisma.deployment.update({
        where: { id: d.id },
        data: { plan: { ...plan, text, providerPlans: provider.entries } as object, ...(escalate ? { approvalRequired: true } : {}) },
      });
      if (escalate) {
        const why = provider.destructive ? 'The provider plan deletes or replaces existing resources' : 'A provider could not plan every changed resource';
        await this.event(d.id, 'warn', PHASE.plan, `${why}: production approval required.`);
      }
      return `Plan: ${plan.counts.CREATE} to create, ${plan.counts.UPDATE} to update, ${plan.counts.DELETE} to delete, ${plan.counts.NOOP} unchanged (risk ${provider.destructive ? 'high' : plan.risk}).`;
    });

    const current = await prisma.deployment.findUniqueOrThrow({ where: { id: d.id } });
    const approvalStep = await prisma.deploymentStep.findUnique({ where: { deploymentId_key: { deploymentId: d.id, key: PHASE.approval } } });
    if (!current.approvalRequired && approvalStep?.status === 'PENDING') {
      await this.step(d.id, PHASE.approval, 'SKIPPED', { errorMessage: 'Not needed: no high-risk or destructive changes planned.' });
      await this.event(d.id, 'info', PHASE.approval, 'Approval not needed: no high-risk or destructive changes planned.');
    }
    if (current.approvalRequired) {
      if (!current.approvedAt) {
        await this.moveInstance(d, 'AWAITING_APPROVAL');
        await prisma.deployment.update({ where: { id: d.id }, data: { status: 'AWAITING_APPROVAL' } });
        await this.step(d.id, PHASE.approval, 'RUNNING');
        await this.event(d.id, 'warn', PHASE.approval, 'High-risk production change: waiting for approval.');
        await notify(this.ctx, { tenantId: d.tenantId, event: 'deployment.awaiting_approval', title: 'Deployment awaiting approval', body: 'A production deployment needs approval before changes are applied.', link: `/deployments/${d.id}`, data: { deploymentId: d.id, instanceId: d.instanceId, kind: d.kind } });
        log.info('parked for approval');
        return;
      }
      await this.step(d.id, PHASE.approval, 'SUCCEEDED');
      await prisma.deployment.update({ where: { id: d.id }, data: { status: 'RUNNING' } });
    }

    await this.moveInstance(d, 'PROVISIONING');
    await notify(this.ctx, { tenantId: d.tenantId, event: 'deployment.started', title: 'Deployment started', body: 'Infrastructure provisioning has started.', link: `/deployments/${d.id}`, data: { deploymentId: d.id, instanceId: d.instanceId, kind: d.kind } });
    const outcome = await this.provision(d, resolved);
    const statuses = Object.values(outcome);
    if (statuses.some((s) => s !== 'SUCCEEDED')) {
      const cancelled = statuses.includes('CANCELLED');
      const failedSteps = await prisma.deploymentStep.findMany({ where: { deploymentId: d.id, status: 'FAILED' } });
      const first = failedSteps[0];
      if (cancelled) return this.finishCancelled(d, log);
      throw new PhaseFailure((first?.errorClass as FailureClass) ?? 'DEPLOYMENT_ERROR', first ? `${first.key}: ${first.errorMessage}` : 'Provisioning did not complete.');
    }

    // Resources dropped from the template (an upgrade, a disabled resource) are deleted here; the
    // plan already counted them as DELETE, so production approval covered them.
    await this.phase(d, PHASE.prune, async () => this.prune(d, resolved));

    await this.moveInstance(d, 'DEPLOYING');
    await this.phase(d, PHASE.rollout, async () => {
      const services = resolved.resources.filter((r) => r.type === 'compute.container-service');
      for (const s of services) {
        const state = await this.ctx.registry.get(s.provider).getResource(this.providerCtx(resolved, s.targetId, s.region, d.correlationId), { resourceId: s.id, serviceKind: s.type, capability: s.capability, name: s.name });
        if (!state.exists) throw new PhaseFailure('DEPLOYMENT_ERROR', `Service ${s.id} is not running after provisioning.`);
        await this.event(d.id, 'info', PHASE.rollout, `${s.id}: running ${String(s.spec.image ?? 'image')} (${s.spec.replicas ?? 1} replica(s)).`);
      }
      return `${services.length} service(s) rolled out with immutable image digests.`;
    });

    await this.moveInstance(d, 'CONFIGURING');
    await this.phase(d, PHASE.configure, async () => this.configure(d, resolved));

    await this.moveInstance(d, 'VERIFYING');
    let degraded = false;
    await this.phase(d, PHASE.verify, async () => {
      const result = await this.verify(d, resolved);
      degraded = result.degraded;
      return result.summary;
    });

    await this.phase(d, PHASE.observability, async () => {
      await syncStatusComponents(this.ctx, d.instanceId, d.tenantId);
      return 'Status components and health monitoring registered.';
    });

    await this.phase(d, PHASE.finalize, async () => {
      const rows = await prisma.instanceResource.findMany({ where: { instanceId: d.instanceId, status: 'ACTIVE' } });
      const outputs = Object.fromEntries(rows.map((r) => [r.resourceId, r.outputs]));
      await prisma.deployment.update({ where: { id: d.id }, data: { status: 'SUCCEEDED', finishedAt: new Date(), outputs: outputs as object } });
      // The template version (an upgrade or rollback) becomes the instance's only now that it is applied.
      await prisma.instance.update({ where: { id: d.instanceId }, data: { desiredStateHash: resolved.desiredStateHash, health: instanceHealth(rows), templateVersionId: d.templateVersionId } });
      await this.moveInstance(d, degraded ? 'DEGRADED' : 'READY');
      return degraded ? 'Instance is up but degraded.' : 'Instance is READY.';
    });

    await notify(this.ctx, { tenantId: d.tenantId, event: 'deployment.succeeded', title: 'Deployment completed', body: degraded ? 'The deployment completed, but some components are degraded.' : 'Your environment is ready.', link: `/deployments/${d.id}`, data: { deploymentId: d.id, instanceId: d.instanceId, kind: d.kind } });
    await systemAudit(this.ctx, { tenantId: d.tenantId, resourceType: 'Deployment', resourceId: d.id, action: 'COMPLETE', correlationId: d.correlationId, changes: { kind: 'APPLY', degraded } });
    log.info({ degraded }, 'deployment succeeded');
  }

  private async provision(d: Deployment, resolved: ResolvedInfrastructure) {
    const prisma = this.ctx.prisma;
    const existing = await prisma.instanceResource.findMany({ where: { instanceId: d.instanceId, status: 'ACTIVE' } });
    const completed: CompletedResources = Object.fromEntries(
      // Drifted resources are applied again: that is what restores the template's configuration.
      existing.filter((r) => r.idempotencyKey && r.drift !== 'DRIFT_DETECTED').map((r) => [r.resourceId, { idempotencyKey: r.idempotencyKey!, outputs: r.outputs as Record<string, string>, providerResourceId: r.providerResourceId ?? '' }]),
    );
    const byId = new Map(resolved.resources.map((r) => [r.id, r]));
    // Start of each resource's current attempt, for the provider duration metric.
    const started = new Map<string, number>();
    const abort = new AbortController();
    const poll = setInterval(async () => {
      const row = await prisma.deployment.findUnique({ where: { id: d.id }, select: { cancelRequestedAt: true } }).catch(() => null);
      if (row?.cancelRequestedAt && !abort.signal.aborted) abort.abort();
    }, CANCEL_POLL_MS);

    try {
      return await executeApply({
        resolved,
        registry: this.ctx.registry,
        tenantId: d.tenantId,
        instanceId: d.instanceId,
        correlationId: d.correlationId,
        planId: d.id,
        completed,
        only: d.onlyResources.length > 0 ? new Set(d.onlyResources) : undefined,
        concurrency: this.ctx.config.WORKER_CONCURRENCY,
        signal: abort.signal,
        log: (id, level, message) => void this.event(d.id, level, id, message).catch(() => {}),
        hooks: {
          onStart: async (id, attempt) => {
            started.set(id, Date.now());
            await this.step(d.id, id, 'RUNNING', { attempt });
            const r = byId.get(id)!;
            await prisma.instanceResource.upsert({
              where: { instanceId_resourceId: { instanceId: d.instanceId, resourceId: id } },
              update: { status: 'PENDING', knowledge: 'DESIRED', targetId: r.targetId, region: r.region, capability: r.capability, capabilityName: r.capabilityName, name: r.name },
              create: {
                tenantId: d.tenantId,
                instanceId: d.instanceId,
                resourceId: id,
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
              },
            });
            if (attempt === 1) await this.event(d.id, 'info', id, `Provisioning ${r.capabilityName} "${r.name}" in ${r.simulatedProvider ?? r.provider}/${r.region}.`);
          },
          onSuccess: async (id, result: ResourceResult) => {
            const r = byId.get(id)!;
            platformMetrics.provider(r.provider, 'apply', Date.now() - (started.get(id) ?? Date.now()), 'ok');
            await prisma.instanceResource.update({
              where: { instanceId_resourceId: { instanceId: d.instanceId, resourceId: id } },
              data: {
                status: 'ACTIVE',
                knowledge: 'ACTUAL',
                providerResourceId: result.providerResourceId,
                outputs: result.outputs,
                specHash: r.specHash,
                idempotencyKey: idempotencyKeyFor(d.tenantId, d.instanceId, r),
                drift: 'IN_SYNC',
                driftCheckedAt: new Date(),
                driftDetails: { actions: [] },
              },
            });
            await this.step(d.id, id, 'SUCCEEDED');
            await this.event(d.id, 'info', id, result.unchanged ? `${id}: already up to date.` : `${id}: ready (${result.providerResourceId}).`);
          },
          onFailure: async (id, f: StepFailure, attempt) => {
            platformMetrics.provider(byId.get(id)?.provider ?? 'unknown', 'apply', Date.now() - (started.get(id) ?? Date.now()), 'error', f.failureClass);
            await prisma.instanceResource.updateMany({ where: { instanceId: d.instanceId, resourceId: id }, data: { status: 'FAILED', knowledge: 'UNKNOWN' } });
            await this.step(d.id, id, f.code === 'CANCELLED' ? 'CANCELLED' : 'FAILED', { attempt, errorClass: f.failureClass, errorMessage: f.message });
            await this.event(d.id, 'error', id, `${id} failed (${f.failureClass}) after ${attempt} attempt(s): ${f.message}`);
          },
          onSkipped: async (id, reason) => {
            await this.step(d.id, id, reason.includes('cancel') ? 'CANCELLED' : 'SKIPPED', { errorMessage: reason });
            await this.event(d.id, 'warn', id, `${id} skipped: ${reason}`);
          },
          onRetry: async (id, attempt, delayMs, f) => {
            platformMetrics.provider(byId.get(id)?.provider ?? 'unknown', 'apply', Date.now() - (started.get(id) ?? Date.now()), 'error', f.failureClass);
            await this.event(d.id, 'warn', id, `${id}: ${f.failureClass} on attempt ${attempt}; retrying in ${Math.round(delayMs / 1000)}s.`);
          },
        },
      });
    } finally {
      clearInterval(poll);
    }
  }

  /** Wires connection references into services. Only references are stored, never values (spec §21). */
  private async configure(d: Deployment, resolved: ResolvedInfrastructure): Promise<string> {
    const prisma = this.ctx.prisma;
    const rows = new Map((await prisma.instanceResource.findMany({ where: { instanceId: d.instanceId } })).map((r) => [r.resourceId, r]));
    let wired = 0;
    for (const svc of resolved.resources.filter((r) => r.type === 'compute.container-service')) {
      const env: Record<string, string> = {};
      for (const c of resolved.connectivity.filter((x) => x.from === svc.id)) {
        const target = rows.get(c.to);
        const out = (target?.outputs ?? {}) as Record<string, unknown>;
        const key = c.to.toUpperCase().replace(/-/g, '_');
        if (out.secretRef) env[`${key}_CREDENTIALS_REF`] = String(out.secretRef);
        if (out.host) env[`${key}_HOST`] = String(out.host);
        if (out.port) env[`${key}_PORT`] = String(out.port);
        if (out.queueUrl) env[`${key}_URL`] = String(out.queueUrl);
        if (out.bucket) env[`${key}_BUCKET`] = String(out.bucket);
        if (out.endpoint) env[`${key}_ENDPOINT`] = String(out.endpoint);
        if (c.crossCloud) env[`${key}_TLS_REQUIRED`] = 'true';
      }
      const current = (rows.get(svc.id)?.outputs ?? {}) as Record<string, unknown>;
      await prisma.instanceResource.update({
        where: { instanceId_resourceId: { instanceId: d.instanceId, resourceId: svc.id } },
        data: { outputs: { ...current, envRefs: env } as object },
      });
      wired += Object.keys(env).length;
      await this.event(d.id, 'info', PHASE.configure, `${svc.id}: ${Object.keys(env).length} connection reference(s) configured.`);
    }
    return `${wired} configuration reference(s) wired; secret values stay in the secret store.`;
  }

  private async verify(d: Deployment, resolved: ResolvedInfrastructure): Promise<{ degraded: boolean; summary: string }> {
    const prisma = this.ctx.prisma;
    let unhealthyCritical = 0;
    let unhealthyOther = 0;
    // Real resources settle after apply (tasks start, targets pass health checks): poll a while,
    // within one settle window for the whole deployment, not one per resource.
    const deadline = Date.now() + VERIFY_SETTLE_MS;
    for (const r of resolved.resources) {
      const adapter = this.ctx.registry.get(r.provider);
      const ident = { resourceId: r.id, serviceKind: r.type, capability: r.capability, name: r.name };
      const pctx = this.providerCtx(resolved, r.targetId, r.region, d.correlationId);
      let health = await adapter.checkHealth(pctx, ident);
      while (health.state !== 'HEALTHY' && !adapter.simulated && Date.now() < deadline) {
        // Gone is not "settling": a resource deleted out of band will not come back by waiting.
        if ((await adapter.probeExists?.(pctx, ident)) === false) {
          health = { ...health, state: 'UNHEALTHY', message: 'Resource no longer exists at the provider. Redeploy to re-create it.' };
          break;
        }
        await this.event(d.id, 'info', PHASE.verify, `${r.id}: ${health.message ?? health.state}; waiting for it to settle.`);
        await new Promise((resolve) => setTimeout(resolve, VERIFY_POLL_MS));
        health = await adapter.checkHealth(pctx, ident);
      }
      await prisma.instanceResource.update({
        where: { instanceId_resourceId: { instanceId: d.instanceId, resourceId: r.id } },
        data: { health: health.state, healthMessage: health.message, healthCheckedAt: new Date(), consecutiveHealthFailures: health.state === 'UNHEALTHY' ? 1 : 0 },
      });
      if (health.state === 'UNHEALTHY') {
        if (r.critical) unhealthyCritical++;
        else unhealthyOther++;
        await this.event(d.id, 'warn', PHASE.verify, `${r.id}: ${health.message ?? 'unhealthy'}`);
      }
    }
    for (const c of resolved.connectivity) {
      const ok = (await prisma.instanceResource.findMany({ where: { instanceId: d.instanceId, resourceId: { in: [c.from, c.to] }, health: 'HEALTHY' } })).length === 2;
      // Both ends healthy is what the worker can tell: it does not sit in either network, so a TCP
      // connect from here would prove nothing about the path between them (open item 4).
      const wired = [
        c.wiring?.credentials === 'copied' ? 'credentials copied' : '',
        c.wiring?.allowlistNetwork ? `firewall allows ${c.wiring.allowlistNetwork} egress` : '',
      ].filter(Boolean);
      await this.event(
        d.id,
        ok ? 'info' : 'warn',
        PHASE.verify,
        `Connectivity ${c.from} → ${c.to} via ${c.strategy}${wired.length ? ` (${wired.join(', ')})` : ''}: ${ok ? 'both ends healthy' : 'an end is NOT healthy'}${resolved.resources.every((r) => r.provider === 'mock') ? ' (simulated)' : ''}.`,
      );
      if (!ok) unhealthyOther++;
    }
    if (unhealthyCritical > 0) throw new PhaseFailure('HEALTH_CHECK_FAILED', `${unhealthyCritical} critical resource(s) failed health checks.`);
    return { degraded: unhealthyOther > 0, summary: unhealthyOther > 0 ? `${unhealthyOther} non-critical check(s) failed.` : 'All health and connectivity checks passed.' };
  }

  /**
   * Deletes resources the instance still has but the applied template no longer contains,
   * dependents first (dependencies from the last successful apply). Protected instances keep
   * them, with a warning, until the protection is removed.
   */
  private async prune(d: Deployment, resolved: ResolvedInfrastructure): Promise<string> {
    const prisma = this.ctx.prisma;
    const keep = new Set(resolved.resources.map((r) => r.id));
    const rows = (await prisma.instanceResource.findMany({ where: { instanceId: d.instanceId, status: { in: ['ACTIVE', 'FAILED'] } } })).filter((r) => !keep.has(r.resourceId));
    if (rows.length === 0) return 'Nothing to remove.';
    const ids = rows.map((r) => r.resourceId);
    const instance = await prisma.instance.findUniqueOrThrow({ where: { id: d.instanceId } });
    if (instance.protectedFromDestroy) {
      await this.event(d.id, 'warn', PHASE.prune, `Kept ${ids.join(', ')}: the instance is protected from destruction. Remove the protection and deploy again to delete them.`);
      return `${rows.length} resource(s) kept because the instance is protected.`;
    }

    const last = await prisma.deployment.findFirst({ where: { instanceId: d.instanceId, kind: 'APPLY', status: 'SUCCEEDED', id: { not: d.id } }, orderBy: { queuedAt: 'desc' } });
    const previous = new Map(((last?.resolved ?? null) as ResolvedInfrastructure | null)?.resources.map((r) => [r.id, r.dependsOn]) ?? []);
    const removed = new Set(ids);
    const targets = await prisma.cloudTarget.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.targetId))] } } });
    const pruned: ResolvedInfrastructure = {
      ...resolved,
      targets: { ...resolved.targets, ...Object.fromEntries(targets.map((t) => [t.id, toCloudTarget(t)])) },
      resources: rows.map((r) => ({
        id: r.resourceId,
        type: r.type,
        slot: r.slot,
        provider: r.provider,
        simulatedProvider: r.simulatedProvider ?? undefined,
        targetId: r.targetId,
        targetName: targets.find((t) => t.id === r.targetId)?.name ?? r.targetId,
        region: r.region,
        capability: r.capability,
        capabilityName: r.capabilityName,
        name: r.name,
        tags: {},
        spec: {},
        dependsOn: (previous.get(r.resourceId) ?? []).filter((dep) => removed.has(dep)),
        critical: r.critical,
        specHash: r.specHash ?? '',
      })),
    };
    const outcome = await executeDestroy({
      resolved: pruned,
      registry: this.ctx.registry,
      correlationId: d.correlationId,
      providerIds: Object.fromEntries(rows.map((r) => [r.resourceId, r.providerResourceId ?? undefined])),
      concurrency: this.ctx.config.WORKER_CONCURRENCY,
      hooks: {
        onStart: async (id) => this.event(d.id, 'info', PHASE.prune, `Deleting ${id} (no longer in the template).`),
        onSuccess: async (id) => {
          await prisma.instanceResource.updateMany({ where: { instanceId: d.instanceId, resourceId: id }, data: { status: 'DELETED', knowledge: 'ACTUAL', health: 'UNKNOWN' } });
          await this.event(d.id, 'info', PHASE.prune, `${id} deleted.`);
        },
        onFailure: async (id, f) => this.event(d.id, 'error', PHASE.prune, `${id} could not be deleted (${f.failureClass}): ${f.message}`),
        onSkipped: async (id, reason) => this.event(d.id, 'warn', PHASE.prune, `${id} retained: ${reason}`),
      },
    });
    const failed = Object.entries(outcome).filter(([, s]) => s !== 'SUCCEEDED').map(([id]) => id);
    if (failed.length) throw new PhaseFailure('DEPLOYMENT_ERROR', `Could not delete ${failed.join(', ')}; they were retained. Retry the deployment.`);
    return `${rows.length} resource(s) removed: ${ids.join(', ')}.`;
  }

  // ───────────────────────────── DESTROY ─────────────────────────────

  private async destroy(d: Deployment, resolved: ResolvedInfrastructure, log: Logger) {
    const prisma = this.ctx.prisma;
    await this.phase(d, PHASE.validate, async () => {
      const instance = await prisma.instance.findUniqueOrThrow({ where: { id: d.instanceId } });
      if (instance.protectedFromDestroy) throw new PhaseFailure('POLICY_VIOLATION', 'Instance is protected from destruction.');
      return 'Authorization and protection policy checked.';
    });
    await this.phase(d, PHASE.backup, async () => {
      const dbs = resolved.resources.filter((r) => r.type === 'database.postgresql');
      for (const db of dbs) {
        const backup = (db.spec.backup ?? {}) as { enabled?: boolean; retentionDays?: number };
        await this.event(d.id, backup.enabled ? 'info' : 'warn', PHASE.backup, backup.enabled
          ? `${db.id}: automated backups retained for ${backup.retentionDays} day(s) after deletion per provider policy${db.provider === 'mock' ? ' (simulated)' : ''}.`
          : `${db.id}: backups are disabled, so data will not be recoverable.`);
      }
      return dbs.length ? `${dbs.length} database(s) checked.` : 'No databases to back up.';
    });
    await this.phase(d, PHASE.plan, async () => `Destroy plan: ${resolved.resources.length} resource(s), dependents first.`);

    const current = await prisma.deployment.findUniqueOrThrow({ where: { id: d.id } });
    if (current.approvalRequired) {
      if (!current.approvedAt) {
        await prisma.deployment.update({ where: { id: d.id }, data: { status: 'AWAITING_APPROVAL' } });
        await this.step(d.id, PHASE.approval, 'RUNNING');
        await this.event(d.id, 'warn', PHASE.approval, 'Destroying a production instance: waiting for approval.');
        await notify(this.ctx, { tenantId: d.tenantId, event: 'deployment.awaiting_approval', title: 'Destroy awaiting approval', body: 'Destroying a production instance needs approval before anything is deleted.', link: `/deployments/${d.id}`, data: { deploymentId: d.id, instanceId: d.instanceId, kind: d.kind } });
        log.info('destroy parked for approval');
        return;
      }
      await this.step(d.id, PHASE.approval, 'SUCCEEDED');
      await prisma.deployment.update({ where: { id: d.id }, data: { status: 'RUNNING' } });
    }

    const rows = await prisma.instanceResource.findMany({ where: { instanceId: d.instanceId } });
    const outcome = await executeDestroy({
      resolved,
      registry: this.ctx.registry,
      correlationId: d.correlationId,
      providerIds: Object.fromEntries(rows.map((r) => [r.resourceId, r.providerResourceId ?? undefined])),
      concurrency: this.ctx.config.WORKER_CONCURRENCY,
      hooks: {
        onStart: async (id) => {
          await this.step(d.id, id, 'RUNNING', { attempt: 1 });
          await this.event(d.id, 'info', id, `Deleting ${id}.`);
        },
        onSuccess: async (id) => {
          await prisma.instanceResource.updateMany({ where: { instanceId: d.instanceId, resourceId: id }, data: { status: 'DELETED', knowledge: 'ACTUAL', health: 'UNKNOWN' } });
          await this.step(d.id, id, 'SUCCEEDED');
          await this.event(d.id, 'info', id, `${id} deleted.`);
        },
        onFailure: async (id, f) => {
          await this.step(d.id, id, 'FAILED', { attempt: 1, errorClass: f.failureClass, errorMessage: f.message });
          await this.event(d.id, 'error', id, `${id} could not be deleted (${f.failureClass}): ${f.message}`);
        },
        onSkipped: async (id, reason) => {
          await this.step(d.id, id, 'SKIPPED', { errorMessage: reason });
          await this.event(d.id, 'warn', id, `${id} retained: ${reason}`);
        },
      },
    });
    if (Object.values(outcome).some((s) => s !== 'SUCCEEDED')) {
      throw new PhaseFailure('DEPLOYMENT_ERROR', 'Some resources could not be deleted and were retained. Review and retry.');
    }

    await this.phase(d, PHASE.cleanup, async () => {
      let leftovers = 0;
      for (const r of resolved.resources) {
        const state = await this.ctx.registry.get(r.provider).getResource(this.providerCtx(resolved, r.targetId, r.region, d.correlationId), { resourceId: r.id, serviceKind: r.type, capability: r.capability, name: r.name });
        if (state.exists) leftovers++;
      }
      if (leftovers > 0) throw new PhaseFailure('DEPLOYMENT_ERROR', `${leftovers} resource(s) still exist at the provider.`);
      return 'Provider confirms all resources are gone.';
    });
    await this.phase(d, PHASE.finalize, async () => {
      await prisma.statusComponent.deleteMany({ where: { instanceId: d.instanceId } });
      await prisma.deployment.update({ where: { id: d.id }, data: { status: 'SUCCEEDED', finishedAt: new Date() } });
      await prisma.instance.update({ where: { id: d.instanceId }, data: { health: 'UNKNOWN' } });
      await this.moveInstance(d, 'DESTROYED');
      return 'Instance destroyed.';
    });
    await systemAudit(this.ctx, { tenantId: d.tenantId, resourceType: 'Deployment', resourceId: d.id, action: 'COMPLETE', correlationId: d.correlationId, changes: { kind: 'DESTROY' } });
    log.info('destroy succeeded');
  }

  // ───────────────────────────── helpers ─────────────────────────────

  /** Runs a phase once: a phase already SUCCEEDED (from an earlier, interrupted run) is skipped. */
  private async phase(d: Deployment, key: string, body: () => Promise<string>): Promise<void> {
    const step = await this.ctx.prisma.deploymentStep.findUnique({ where: { deploymentId_key: { deploymentId: d.id, key } } });
    if (!step || step.status === 'SUCCEEDED') return;
    const cancel = await this.ctx.prisma.deployment.findUnique({ where: { id: d.id }, select: { cancelRequestedAt: true } });
    if (cancel?.cancelRequestedAt) throw new PhaseFailure('UNKNOWN', 'Cancelled by operator.');
    await this.step(d.id, key, 'RUNNING', { attempt: step.attempt + 1 });
    try {
      const summary = await body();
      await this.step(d.id, key, 'SUCCEEDED');
      await this.event(d.id, 'info', key, summary);
    } catch (err) {
      const f = err instanceof PhaseFailure ? { failureClass: err.failureClass, message: err.message } : toFailure(err);
      await this.step(d.id, key, 'FAILED', { errorClass: f.failureClass, errorMessage: f.message });
      await this.event(d.id, 'error', key, f.message);
      throw err;
    }
  }

  private async step(deploymentId: string, key: string, status: StepStatus, extra: { attempt?: number; errorClass?: string; errorMessage?: string } = {}) {
    const now = new Date();
    await this.ctx.prisma.deploymentStep.updateMany({
      where: { deploymentId, key },
      data: {
        status,
        ...(extra.attempt !== undefined ? { attempt: extra.attempt } : {}),
        ...(status === 'RUNNING' ? { startedAt: now, finishedAt: null, errorClass: null, errorMessage: null } : { finishedAt: now }),
        ...(extra.errorClass ? { errorClass: extra.errorClass } : {}),
        ...(extra.errorMessage ? { errorMessage: extra.errorMessage.slice(0, 1000) } : {}),
      },
    });
  }

  private async event(deploymentId: string, level: 'info' | 'warn' | 'error', stepKey: string | null, message: string) {
    await this.ctx.prisma.deploymentEvent.create({ data: { deploymentId, level, stepKey, message: message.slice(0, 2000) } });
  }

  /** Forward-only instance transitions, validated against the domain state machine. */
  private async moveInstance(d: Deployment, to: InstanceStatus) {
    const instance = await this.ctx.prisma.instance.findUniqueOrThrow({ where: { id: d.instanceId } });
    if (instance.status === to) return;
    const fromIdx = APPLY_ORDER.indexOf(instance.status);
    const toIdx = APPLY_ORDER.indexOf(to);
    if (fromIdx >= 0 && toIdx >= 0 && toIdx < fromIdx) return; // resumed run: already past this point
    assertInstanceTransition(instance.status, to);
    await this.ctx.prisma.$transaction([
      this.ctx.prisma.instance.update({ where: { id: instance.id }, data: { status: to } }),
      this.ctx.prisma.instanceTransition.create({ data: { instanceId: instance.id, tenantId: instance.tenantId, from: instance.status, to, deploymentId: d.id } }),
    ]);
  }

  /** Fails a deployment from outside its job (the stuck deployment reaper). */
  async abandon(deploymentId: string, message: string): Promise<void> {
    const d = await this.ctx.prisma.deployment.findUnique({ where: { id: deploymentId } });
    if (d?.status !== 'RUNNING') return;
    await this.event(d.id, 'error', null, message);
    await this.fail(d, 'TIMEOUT', message);
  }

  private async fail(d: Deployment, failureClass: FailureClass, message: string) {
    const prisma = this.ctx.prisma;
    const steps = await prisma.deploymentStep.findMany({ where: { deploymentId: d.id } });
    const resourceStatuses = steps.filter((s) => s.kind === 'RESOURCE').map((s) => s.status);
    const status = summarizeSteps(resourceStatuses) === 'PARTIALLY_FAILED' ? 'PARTIALLY_FAILED' : 'FAILED';
    // Steps that never started are marked SKIPPED so the UI shows exactly what did not run.
    await prisma.deploymentStep.updateMany({ where: { deploymentId: d.id, status: 'PENDING' }, data: { status: 'SKIPPED' } });
    await prisma.deployment.update({ where: { id: d.id }, data: { status, finishedAt: new Date(), errorClass: failureClass, errorMessage: message.slice(0, 1000) } });

    const instance = await prisma.instance.findUniqueOrThrow({ where: { id: d.instanceId } });
    const failed = FAILED_STATE[instance.status];
    if (failed) {
      await prisma.$transaction([
        prisma.instance.update({ where: { id: instance.id }, data: { status: failed } }),
        prisma.instanceTransition.create({ data: { instanceId: instance.id, tenantId: instance.tenantId, from: instance.status, to: failed, deploymentId: d.id, reason: `${failureClass}: ${message.slice(0, 200)}` } }),
      ]);
    }
    await notify(this.ctx, { tenantId: d.tenantId, event: 'deployment.failed', title: 'Deployment failed', body: `The deployment did not complete (${failureClass}). Open the deployment for details and safe retry options.`, link: `/deployments/${d.id}`, data: { deploymentId: d.id, instanceId: d.instanceId, kind: d.kind } });
    await systemAudit(this.ctx, { tenantId: d.tenantId, resourceType: 'Deployment', resourceId: d.id, action: 'COMPLETE', result: 'FAILURE', correlationId: d.correlationId, changes: { failureClass, status } });
  }

  private async finishCancelled(d: Deployment, log: Logger) {
    const prisma = this.ctx.prisma;
    await prisma.deploymentStep.updateMany({ where: { deploymentId: d.id, status: { in: ['PENDING', 'RUNNING'] } }, data: { status: 'CANCELLED', finishedAt: new Date() } });
    await prisma.deployment.update({ where: { id: d.id }, data: { status: 'CANCELLED', finishedAt: new Date() } });
    await this.event(d.id, 'warn', null, 'Deployment cancelled. Completed resources were kept; nothing was rolled back automatically.');
    const instance = await prisma.instance.findUniqueOrThrow({ where: { id: d.instanceId } });
    // A destroy cancelled before deleting anything leaves a working instance: back to READY.
    const deletedSome = d.kind === 'DESTROY' && (await prisma.deploymentStep.count({ where: { deploymentId: d.id, kind: 'RESOURCE', status: 'SUCCEEDED' } })) > 0;
    const failed = d.kind === 'DESTROY' && !deletedSome && instance.status === 'DESTROYING' ? 'READY' : FAILED_STATE[instance.status];
    if (failed) {
      await prisma.$transaction([
        prisma.instance.update({ where: { id: instance.id }, data: { status: failed } }),
        prisma.instanceTransition.create({ data: { instanceId: instance.id, tenantId: instance.tenantId, from: instance.status, to: failed, deploymentId: d.id, reason: 'cancelled' } }),
      ]);
    }
    log.warn('deployment cancelled');
  }

  private providerCtx(resolved: ResolvedInfrastructure, targetId: string, region: string, correlationId: string) {
    return { target: resolved.targets[targetId]!, region, correlationId };
  }

  private async known(instanceId: string): Promise<KnownResource[]> {
    const rows = await this.ctx.prisma.instanceResource.findMany({ where: { instanceId, status: { in: ['ACTIVE', 'FAILED'] } } });
    return rows.map((r) => ({ drifted: r.drift === 'DRIFT_DETECTED', resourceId: r.resourceId, type: r.type, specHash: r.status === 'ACTIVE' ? r.specHash : null, targetId: r.targetId, region: r.region, provider: r.simulatedProvider ?? r.provider, capabilityName: r.capabilityName, name: r.name }));
  }
}
