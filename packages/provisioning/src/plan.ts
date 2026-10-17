// SPDX-License-Identifier: AGPL-3.0-only
import { effectiveProvider } from './connectivity.js';
import type { ResolvedConnectivity, ResolvedInfrastructure, ResolvedResource } from './types.js';

export type PlanAction = 'CREATE' | 'UPDATE' | 'DELETE' | 'NOOP';

/** What the platform currently believes exists (KNOWN, not ACTUAL — spec §93). */
export interface KnownResource {
  /** Changed outside the platform (last drift check): applying again restores it. */
  drifted?: boolean;
  resourceId: string;
  type: string;
  specHash: string | null;
  targetId: string;
  region: string;
  provider: string;
  capabilityName: string;
  name: string;
}

export interface PlannedChange {
  resourceId: string;
  action: PlanAction;
  type: string;
  capabilityName: string;
  name: string;
  provider: string;
  targetId: string;
  targetName: string;
  region: string;
  /** A change of target/region/capability means replacement, which is destructive. */
  replacement: boolean;
  /** Why an otherwise unchanged resource is applied again. */
  reason?: 'restore-drift';
}

export interface PlanGroup {
  provider: string;
  targetName: string;
  region: string;
  changes: PlannedChange[];
}

export interface DeploymentPlan {
  changes: PlannedChange[];
  /** Human-readable topology grouped by provider / target / region (spec §42.10). */
  groups: PlanGroup[];
  counts: Record<PlanAction, number>;
  risk: 'low' | 'medium' | 'high';
  crossCloud: string[];
}

export function diffPlan(resolved: ResolvedInfrastructure, known: KnownResource[]): DeploymentPlan {
  const knownById = new Map(known.map((k) => [k.resourceId, k]));
  const changes: PlannedChange[] = resolved.resources.map((r) => change(r, knownById.get(r.id), resolved));

  for (const k of known) {
    if (!resolved.resources.some((r) => r.id === k.resourceId)) {
      changes.push({
        resourceId: k.resourceId,
        action: 'DELETE',
        type: k.type,
        capabilityName: k.capabilityName,
        name: k.name,
        provider: k.provider,
        targetId: k.targetId,
        targetName: resolved.targets[k.targetId]?.name ?? k.targetId,
        region: k.region,
        replacement: false,
      });
    }
  }

  const counts: Record<PlanAction, number> = { CREATE: 0, UPDATE: 0, DELETE: 0, NOOP: 0 };
  for (const c of changes) counts[c.action]++;

  const groups = new Map<string, PlanGroup>();
  for (const c of changes) {
    const key = `${c.provider}|${c.targetName}|${c.region}`;
    if (!groups.has(key)) groups.set(key, { provider: c.provider, targetName: c.targetName, region: c.region, changes: [] });
    groups.get(key)!.changes.push(c);
  }

  const destructive = counts.DELETE > 0 || changes.some((c) => c.replacement);
  const touchesData = changes.some((c) => c.action !== 'NOOP' && c.action !== 'CREATE' && c.type === 'database.postgresql');
  const risk = destructive || touchesData ? 'high' : counts.UPDATE > 0 ? 'medium' : 'low';

  return {
    changes,
    groups: [...groups.values()],
    counts,
    risk,
    crossCloud: resolved.connectivity.filter((c) => c.crossCloud).map(describeLink),
  };
}

function change(r: ResolvedResource, k: KnownResource | undefined, resolved: ResolvedInfrastructure): PlannedChange {
  const replacement = Boolean(k && (k.targetId !== r.targetId || k.region !== r.region || k.capabilityName !== r.capabilityName));
  const unchanged = Boolean(k && k.specHash !== null && k.specHash === r.specHash);
  const action: PlanAction = !k || k.specHash === null ? 'CREATE' : unchanged && !k.drifted ? 'NOOP' : 'UPDATE';
  return {
    ...(unchanged && k?.drifted ? { reason: 'restore-drift' as const } : {}),
    resourceId: r.id,
    action,
    type: r.type,
    capabilityName: r.capabilityName,
    name: r.name,
    provider: effectiveProvider(r),
    targetId: r.targetId,
    targetName: resolved.targets[r.targetId]?.name ?? r.targetName,
    region: r.region,
    replacement,
  };
}

/** One cross cloud link and what OrkStage wires for it. */
function describeLink(c: ResolvedConnectivity): string {
  const parts = [`${c.from} → ${c.to} (${c.strategy})`];
  if (c.wiring.credentials === 'copied') parts.push(`credentials copied to ${c.from}'s secret store`);
  if (c.wiring.credentials === 'reference') parts.push('credentials passed as a reference only');
  if (c.wiring.allowlistNetwork) parts.push(`firewall allows ${c.wiring.allowlistNetwork} egress only`);
  if (c.wiring.allowlistGap) parts.push('no allowlist');
  return parts.join('; ');
}

/** Plain-text rendering of a plan, used in approval requests and logs. */
export function renderPlan(instanceName: string, plan: DeploymentPlan): string {
  const lines = ['Deployment Plan', '', `Instance: ${instanceName}`, ''];
  for (const g of plan.groups) {
    lines.push(`${g.provider.toUpperCase()} / ${g.targetName} / ${g.region}`);
    for (const c of g.changes) lines.push(`  ${c.action.padEnd(6)} ${c.capabilityName} ${c.resourceId}${c.replacement ? ' (replace)' : ''}${c.reason === 'restore-drift' ? ' (restore drift)' : ''}`);
    lines.push('');
  }
  if (plan.crossCloud.length) {
    lines.push('Cross-cloud');
    for (const c of plan.crossCloud) lines.push(`  CONFIGURE ${c}`);
    lines.push('');
  }
  lines.push(`Risk: ${plan.risk}`);
  return lines.join('\n');
}
