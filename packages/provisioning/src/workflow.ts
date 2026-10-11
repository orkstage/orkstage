import type { DeploymentPlan } from './plan.js';
import type { ResolvedInfrastructure } from './types.js';

export type WorkflowKind = 'APPLY' | 'DESTROY';

export interface WorkflowStep {
  key: string;
  kind: 'PHASE' | 'RESOURCE';
  name: string;
  position: number;
  provider?: string;
  region?: string;
}

/** Phase keys. The worker executes these; the API creates them up front so progress is visible. */
export const PHASE = {
  validate: 'phase:validate',
  targets: 'phase:targets',
  plan: 'phase:plan',
  approval: 'phase:approval',
  backup: 'phase:backup',
  prune: 'phase:prune',
  rollout: 'phase:rollout',
  configure: 'phase:configure',
  verify: 'phase:verify',
  observability: 'phase:observability',
  cleanup: 'phase:cleanup',
  finalize: 'phase:finalize',
} as const;

const NAMES: Record<string, string> = {
  [PHASE.validate]: 'Validate template and policies',
  [PHASE.targets]: 'Validate cloud targets',
  [PHASE.plan]: 'Generate plan',
  [PHASE.approval]: 'Approval',
  [PHASE.backup]: 'Confirm backup policy',
  [PHASE.prune]: 'Remove resources no longer in the template',
  [PHASE.rollout]: 'Application rollout',
  [PHASE.configure]: 'Configure secrets and connections',
  [PHASE.verify]: 'Health and connectivity verification',
  [PHASE.observability]: 'Register observability',
  [PHASE.cleanup]: 'Verify cleanup',
  [PHASE.finalize]: 'Finalize',
};

/**
 * The ordered steps of a deployment (spec §16, §42.11, §62). Resource steps follow DAG levels,
 * reversed for destroy so dependents go first.
 */
export function workflowSteps(kind: WorkflowKind, resolved: ResolvedInfrastructure, approvalRequired: boolean): WorkflowStep[] {
  const phases = (keys: string[]) => keys.map((key) => ({ key, kind: 'PHASE' as const, name: NAMES[key]! }));
  const byId = new Map(resolved.resources.map((r) => [r.id, r]));
  const levels = kind === 'APPLY' ? resolved.levels : [...resolved.levels].reverse();
  const resources = levels.flat().map((id) => {
    const r = byId.get(id)!;
    return {
      key: id,
      kind: 'RESOURCE' as const,
      name: `${kind === 'APPLY' ? '' : 'Delete '}${r.capabilityName} — ${id}`,
      provider: r.simulatedProvider ?? r.provider,
      region: r.region,
    };
  });

  const steps =
    kind === 'APPLY'
      ? [
          ...phases([PHASE.validate, PHASE.targets, PHASE.plan, ...(approvalRequired ? [PHASE.approval] : [])]),
          ...resources,
          ...phases([PHASE.prune, PHASE.rollout, PHASE.configure, PHASE.verify, PHASE.observability, PHASE.finalize]),
        ]
      : [
          ...phases([PHASE.validate, PHASE.backup, PHASE.plan, ...(approvalRequired ? [PHASE.approval] : [])]),
          ...resources,
          ...phases([PHASE.cleanup, PHASE.finalize]),
        ];
  return steps.map((s, i) => ({ ...s, position: i }));
}

/**
 * Approval policy: production changes that delete, replace or touch databases need an explicit
 * approval before apply. Everything else proceeds automatically.
 */
export function requiresApproval(environment: string, plan: DeploymentPlan): boolean {
  return environment === 'production' && plan.risk === 'high';
}
