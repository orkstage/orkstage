// SPDX-License-Identifier: AGPL-3.0-only
import type { AdapterRegistry, ResourceOutputs, ResourcePlan } from '@orkstage/cloud-core';
import { idempotencyKeyFor, readDependencySecret } from './executor.js';
import type { ResolvedInfrastructure } from './types.js';

export type ProviderPlanEntry =
  | { resourceId: string; status: 'planned'; plan: ResourcePlan }
  | { resourceId: string; status: 'skipped'; reason: string }
  | { resourceId: string; status: 'error'; reason: string };

export interface ProviderPlanSummary {
  entries: ProviderPlanEntry[];
  /** Any planned delete/replace: production changes like this need explicit approval. */
  destructive: boolean;
  /** A provider could not plan a resource: in production, nobody approves what was not seen. */
  failed: boolean;
}

/**
 * Real provider plans for resources that already exist and changed (spec §16: plan before
 * apply). Each resource has its own state, so a plan needs the actual outputs of its
 * dependencies; brand-new resources are covered by the platform plan (all CREATE).
 */
export async function previewProviderPlans(opts: {
  resolved: ResolvedInfrastructure;
  registry: AdapterRegistry;
  tenantId: string;
  instanceId: string;
  correlationId: string;
  /** The deployment id: plans are saved under it for the apply phase. Absent for previews. */
  planId?: string;
  existing: Record<string, { idempotencyKey: string | null; outputs: ResourceOutputs }>;
  concurrency?: number;
}): Promise<ProviderPlanSummary> {
  const { resolved, registry, existing } = opts;
  const queue = resolved.resources.filter((r) => existing[r.id] && existing[r.id]!.idempotencyKey !== idempotencyKeyFor(opts.tenantId, opts.instanceId, r));
  const entries: ProviderPlanEntry[] = [];

  const work = queue.map((r) => async (): Promise<ProviderPlanEntry> => {
    const adapter = registry.get(r.provider);
    if (!adapter.planResource) return { resourceId: r.id, status: 'skipped', reason: 'Provider adapter has no plan support.' };
    const missing = r.dependsOn.filter((d) => !existing[d]);
    if (missing.length) return { resourceId: r.id, status: 'skipped', reason: `Depends on resources not created yet: ${missing.join(', ')}.` };
    try {
      const plan = await adapter.planResource(
        {
          target: resolved.targets[r.targetId]!,
          region: r.region,
          correlationId: opts.correlationId,
          // Plans of services that copy another provider's credentials need the same values as the apply.
          dependencySecret: (depId) => readDependencySecret(registry, resolved, r, depId, existing[depId]?.outputs, opts.correlationId),
        },
        {
          resourceId: r.id,
          serviceKind: r.type,
          capability: r.capability,
          name: r.name,
          tags: r.tags,
          spec: r.spec,
          dependencyOutputs: Object.fromEntries(r.dependsOn.map((d) => [d, existing[d]!.outputs])),
          idempotencyKey: idempotencyKeyFor(opts.tenantId, opts.instanceId, r),
          planId: opts.planId,
        },
      );
      return { resourceId: r.id, status: 'planned', plan };
    } catch (err) {
      return { resourceId: r.id, status: 'error', reason: (err as Error).message.slice(0, 300) };
    }
  });

  const limit = Math.max(1, opts.concurrency ?? 2);
  for (let i = 0; i < work.length; i += limit) entries.push(...(await Promise.all(work.slice(i, i + limit).map((w) => w()))));
  return {
    entries,
    destructive: entries.some((e) => e.status === 'planned' && e.plan.destructive),
    failed: entries.some((e) => e.status === 'error'),
  };
}

export function describeProviderPlan(e: ProviderPlanEntry): string {
  if (e.status !== 'planned') return `${e.resourceId}: provider plan ${e.status}: ${e.reason}`;
  const { add, change, remove } = e.plan.changes;
  const risky = e.plan.actions.filter((a) => a.action === 'delete' || a.action === 'replace').map((a) => `${a.action} ${a.address}`);
  return `${e.resourceId}: ${add} to add, ${change} to change, ${remove} to destroy${risky.length ? `; ${risky.join(', ')}` : ''}`;
}
