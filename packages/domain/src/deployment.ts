// SPDX-License-Identifier: AGPL-3.0-only
import { InvalidTransitionError } from './errors.js';

export const DEPLOYMENT_KINDS = ['APPLY', 'DESTROY'] as const;
export type DeploymentKind = (typeof DEPLOYMENT_KINDS)[number];

export const DEPLOYMENT_STATUSES = [
  'QUEUED',
  'RUNNING',
  'AWAITING_APPROVAL',
  'SUCCEEDED',
  'FAILED',
  'PARTIALLY_FAILED',
  'CANCELLED',
] as const;
export type DeploymentStatus = (typeof DEPLOYMENT_STATUSES)[number];

/**
 * Per-step status. SKIPPED means a step never ran because something it depends on failed,
 * which is how partial multi-cloud failures stay visible (spec §42.12).
 */
export const STEP_STATUSES = ['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED', 'CANCELLED'] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

const DEPLOYMENT_TRANSITIONS: Record<DeploymentStatus, readonly DeploymentStatus[]> = {
  QUEUED: ['RUNNING', 'CANCELLED'],
  RUNNING: ['AWAITING_APPROVAL', 'SUCCEEDED', 'FAILED', 'PARTIALLY_FAILED', 'CANCELLED'],
  AWAITING_APPROVAL: ['RUNNING', 'CANCELLED'],
  SUCCEEDED: [],
  FAILED: ['RUNNING'],
  PARTIALLY_FAILED: ['RUNNING'],
  CANCELLED: [],
};

export function assertDeploymentTransition(from: DeploymentStatus, to: DeploymentStatus): void {
  if (!DEPLOYMENT_TRANSITIONS[from].includes(to)) {
    throw new InvalidTransitionError('Deployment', from, to);
  }
}

export function isDeploymentTerminal(status: DeploymentStatus): boolean {
  return DEPLOYMENT_TRANSITIONS[status].length === 0 || status === 'FAILED' || status === 'PARTIALLY_FAILED';
}

/** Overall outcome from step outcomes. */
export function summarizeSteps(statuses: readonly StepStatus[]): DeploymentStatus {
  const failed = statuses.some((s) => s === 'FAILED');
  const succeeded = statuses.some((s) => s === 'SUCCEEDED');
  if (statuses.some((s) => s === 'CANCELLED')) return 'CANCELLED';
  if (failed && succeeded) return 'PARTIALLY_FAILED';
  if (failed) return 'FAILED';
  if (statuses.every((s) => s === 'SUCCEEDED')) return 'SUCCEEDED';
  return 'RUNNING';
}
