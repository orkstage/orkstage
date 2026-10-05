import { ProviderError, type AdapterRegistry, type ProviderContext, type ResourceOutputs, type ResourceResult } from '@co/cloud-core';
import { DomainError, isRetryable, operationKey, type FailureClass, type StepStatus } from '@co/domain';
import type { ResolvedInfrastructure, ResolvedResource } from './types.js';

export interface StepFailure {
  code: string;
  message: string;
  failureClass: FailureClass;
  retryable: boolean;
}

/** Persistence callbacks. The executor owns no state; the worker records every transition. */
export interface ExecutionHooks {
  onStart(resourceId: string, attempt: number): Promise<void>;
  onSuccess(resourceId: string, result: ResourceResult): Promise<void>;
  onFailure(resourceId: string, failure: StepFailure, attempt: number): Promise<void>;
  onSkipped(resourceId: string, reason: string): Promise<void>;
  onRetry?(resourceId: string, attempt: number, delayMs: number, failure: StepFailure): Promise<void>;
}

/** Resources already converged by an earlier (interrupted) run, keyed by resource id. */
export type CompletedResources = Record<string, { idempotencyKey: string; outputs: ResourceOutputs; providerResourceId: string }>;

export interface ExecuteOptions {
  resolved: ResolvedInfrastructure;
  registry: AdapterRegistry;
  hooks: ExecutionHooks;
  tenantId: string;
  instanceId: string;
  correlationId: string;
  completed?: CompletedResources;
  /** Only run these resources (and skip the rest as already handled) — used by "retry failed". */
  only?: Set<string>;
  concurrency?: number;
  retry?: { maxAttempts: number; baseDelayMs: number; maxDelayMs: number };
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  /** Adapter progress output per resource (e.g. OpenTofu diagnostics). */
  log?: (resourceId: string, level: 'info' | 'warn' | 'error', message: string) => void;
}

export type ExecutionOutcome = Record<string, StepStatus>;

const DEFAULT_RETRY = { maxAttempts: 4, baseDelayMs: 2000, maxDelayMs: 30000 };

export function idempotencyKeyFor(tenantId: string, instanceId: string, r: ResolvedResource): string {
  return operationKey(tenantId, instanceId, `${r.id}:${r.specHash}`);
}

/**
 * Applies a resolved infrastructure as a DAG (spec §42.11). Independent branches run in
 * parallel up to `concurrency`. A failed resource causes its dependents to be SKIPPED while
 * unrelated branches continue — a storage failure never tears down healthy compute
 * (spec §42.12). Only transient failure classes are retried, with exponential backoff.
 */
export async function executeApply(opts: ExecuteOptions): Promise<ExecutionOutcome> {
  const { resolved, registry, hooks, completed = {}, signal } = opts;
  const retry = opts.retry ?? DEFAULT_RETRY;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const concurrency = Math.max(1, opts.concurrency ?? 4);

  const byId = new Map(resolved.resources.map((r) => [r.id, r]));
  const status: ExecutionOutcome = Object.fromEntries(resolved.resources.map((r) => [r.id, 'PENDING' as StepStatus]));
  const outputs: Record<string, ResourceOutputs> = {};

  // Resume: anything already converged with the same desired state is not re-run.
  for (const r of resolved.resources) {
    const done = completed[r.id];
    const runIt = !opts.only || opts.only.has(r.id);
    if (done && (done.idempotencyKey === idempotencyKeyFor(opts.tenantId, opts.instanceId, r) || !runIt)) {
      status[r.id] = 'SUCCEEDED';
      outputs[r.id] = done.outputs;
    }
  }

  const running = new Map<string, Promise<void>>();

  const runOne = async (r: ResolvedResource) => {
    status[r.id] = 'RUNNING';
    const ctx: ProviderContext = {
      target: resolved.targets[r.targetId]!,
      region: r.region,
      correlationId: opts.correlationId,
      signal,
      log: opts.log ? (level, message) => opts.log!(r.id, level, message) : undefined,
    };
    const adapter = registry.get(r.provider);
    const dependencyOutputs = Object.fromEntries(r.dependsOn.map((d) => [d, outputs[d] ?? {}]));

    for (let attempt = 1; ; attempt++) {
      await hooks.onStart(r.id, attempt);
      try {
        const result = await adapter.ensureResource(ctx, {
          resourceId: r.id,
          serviceKind: r.type,
          capability: r.capability,
          name: r.name,
          tags: r.tags,
          spec: r.spec,
          dependencyOutputs,
          idempotencyKey: idempotencyKeyFor(opts.tenantId, opts.instanceId, r),
        });
        outputs[r.id] = result.outputs;
        status[r.id] = 'SUCCEEDED';
        await hooks.onSuccess(r.id, result);
        return;
      } catch (err) {
        const failure = toFailure(err);
        if (signal?.aborted) {
          status[r.id] = 'CANCELLED';
          await hooks.onFailure(r.id, { ...failure, code: 'CANCELLED', message: 'Cancelled by operator.', retryable: false }, attempt);
          return;
        }
        if (failure.retryable && attempt < retry.maxAttempts) {
          const delay = Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** (attempt - 1));
          await hooks.onRetry?.(r.id, attempt, delay, failure);
          await sleep(delay);
          continue;
        }
        status[r.id] = 'FAILED';
        await hooks.onFailure(r.id, failure, attempt);
        return;
      }
    }
  };

  while (true) {
    // Skip anything whose dependencies failed, were skipped, or were cancelled.
    let changed = true;
    while (changed) {
      changed = false;
      for (const r of resolved.resources) {
        if (status[r.id] !== 'PENDING') continue;
        const blocker = r.dependsOn.find((d) => ['FAILED', 'SKIPPED', 'CANCELLED'].includes(status[d]!));
        if (blocker || signal?.aborted) {
          status[r.id] = signal?.aborted ? 'CANCELLED' : 'SKIPPED';
          await hooks.onSkipped(r.id, blocker ? `Dependency "${blocker}" did not complete.` : 'Deployment cancelled.');
          changed = true;
        }
      }
    }

    const ready = resolved.resources.filter(
      (r) => status[r.id] === 'PENDING' && !running.has(r.id) && r.dependsOn.every((d) => status[d] === 'SUCCEEDED'),
    );
    for (const r of ready) {
      if (running.size >= concurrency) break;
      running.set(r.id, runOne(byId.get(r.id)!).finally(() => running.delete(r.id)));
    }
    if (running.size === 0) break;
    await Promise.race(running.values());
  }

  return status;
}

export interface DestroyOptions {
  resolved: ResolvedInfrastructure;
  registry: AdapterRegistry;
  hooks: Omit<ExecutionHooks, 'onSuccess'> & { onSuccess(resourceId: string): Promise<void> };
  correlationId: string;
  /** Provider ids recorded for each resource, so deletion never relies on names (spec §92). */
  providerIds: Record<string, string | undefined>;
  concurrency?: number;
  signal?: AbortSignal;
}

/**
 * Dependency-aware destroy (spec §62): a resource is deleted only after everything depending
 * on it is gone. If a dependent fails to delete, its dependencies are retained (SKIPPED), never
 * force-deleted. Destructive operations are not retried automatically.
 */
export async function executeDestroy(opts: DestroyOptions): Promise<ExecutionOutcome> {
  const { resolved, registry, hooks, signal } = opts;
  const status: ExecutionOutcome = Object.fromEntries(resolved.resources.map((r) => [r.id, 'PENDING' as StepStatus]));
  const dependents = new Map<string, string[]>(resolved.resources.map((r) => [r.id, []]));
  for (const r of resolved.resources) for (const d of r.dependsOn) dependents.get(d)?.push(r.id);

  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const running = new Map<string, Promise<void>>();

  const runOne = async (r: ResolvedResource) => {
    status[r.id] = 'RUNNING';
    await hooks.onStart(r.id, 1);
    try {
      const ctx: ProviderContext = { target: resolved.targets[r.targetId]!, region: r.region, correlationId: opts.correlationId, signal };
      await registry.get(r.provider).deleteResource(ctx, {
        resourceId: r.id,
        serviceKind: r.type,
        capability: r.capability,
        name: r.name,
        providerResourceId: opts.providerIds[r.id],
      });
      status[r.id] = 'SUCCEEDED';
      await hooks.onSuccess(r.id);
    } catch (err) {
      status[r.id] = 'FAILED';
      await hooks.onFailure(r.id, { ...toFailure(err), retryable: false }, 1);
    }
  };

  while (true) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const r of resolved.resources) {
        if (status[r.id] !== 'PENDING') continue;
        const blocker = dependents.get(r.id)!.find((d) => ['FAILED', 'SKIPPED', 'CANCELLED'].includes(status[d]!));
        if (blocker || signal?.aborted) {
          status[r.id] = signal?.aborted ? 'CANCELLED' : 'SKIPPED';
          await hooks.onSkipped(r.id, blocker ? `Retained because "${blocker}" could not be deleted.` : 'Destroy cancelled.');
          changed = true;
        }
      }
    }
    const ready = resolved.resources.filter(
      (r) => status[r.id] === 'PENDING' && !running.has(r.id) && dependents.get(r.id)!.every((d) => status[d] === 'SUCCEEDED'),
    );
    for (const r of ready) {
      if (running.size >= concurrency) break;
      running.set(r.id, runOne(r).finally(() => running.delete(r.id)));
    }
    if (running.size === 0) break;
    await Promise.race(running.values());
  }
  return status;
}

export function toFailure(err: unknown): StepFailure {
  if (err instanceof ProviderError || err instanceof DomainError) {
    return { code: err.code, message: err.message, failureClass: err.failureClass, retryable: isRetryable(err.failureClass) };
  }
  // Unknown errors may carry sensitive internals; keep the message short and generic.
  const message = err instanceof Error ? err.message.slice(0, 300) : 'Unexpected error.';
  return { code: 'UNEXPECTED_ERROR', message, failureClass: 'UNKNOWN', retryable: false };
}
