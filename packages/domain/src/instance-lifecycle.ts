// SPDX-License-Identifier: AGPL-3.0-only
import { InvalidTransitionError } from './errors.js';

/** Instance lifecycle states (spec §15). */
export const INSTANCE_STATUSES = [
  'DRAFT',
  'VALIDATING',
  'PLANNING',
  'AWAITING_APPROVAL',
  'PROVISIONING',
  'DEPLOYING',
  'CONFIGURING',
  'VERIFYING',
  'READY',
  'VALIDATION_FAILED',
  'PLAN_FAILED',
  'PROVISION_FAILED',
  'DEPLOY_FAILED',
  'VERIFICATION_FAILED',
  'DEGRADED',
  'DESTROYING',
  'DESTROY_FAILED',
  'DESTROYED',
] as const;
export type InstanceStatus = (typeof INSTANCE_STATUSES)[number];

const FAILED_STATES = [
  'VALIDATION_FAILED',
  'PLAN_FAILED',
  'PROVISION_FAILED',
  'DEPLOY_FAILED',
  'VERIFICATION_FAILED',
] as const satisfies readonly InstanceStatus[];

/** States from which a new deployment may be started. */
const DEPLOYABLE_FROM = ['DRAFT', 'READY', 'DEGRADED', ...FAILED_STATES] as const;

const TRANSITIONS: Record<InstanceStatus, readonly InstanceStatus[]> = {
  DRAFT: ['VALIDATING', 'DESTROYED'],
  VALIDATING: ['PLANNING', 'VALIDATION_FAILED'],
  PLANNING: ['AWAITING_APPROVAL', 'PROVISIONING', 'PLAN_FAILED'],
  AWAITING_APPROVAL: ['PROVISIONING', 'PLAN_FAILED'],
  PROVISIONING: ['DEPLOYING', 'PROVISION_FAILED'],
  DEPLOYING: ['CONFIGURING', 'DEPLOY_FAILED'],
  CONFIGURING: ['VERIFYING', 'DEPLOY_FAILED'],
  VERIFYING: ['READY', 'DEGRADED', 'VERIFICATION_FAILED'],
  READY: ['VALIDATING', 'DEGRADED', 'DESTROYING'],
  DEGRADED: ['READY', 'VALIDATING', 'DESTROYING'],
  VALIDATION_FAILED: ['VALIDATING', 'DESTROYING'],
  PLAN_FAILED: ['VALIDATING', 'DESTROYING'],
  PROVISION_FAILED: ['VALIDATING', 'DESTROYING'],
  DEPLOY_FAILED: ['VALIDATING', 'DESTROYING'],
  VERIFICATION_FAILED: ['VALIDATING', 'DESTROYING'],
  // READY: a destroy cancelled (or rejected) before any resource was deleted.
  DESTROYING: ['DESTROYED', 'DESTROY_FAILED', 'READY'],
  DESTROY_FAILED: ['DESTROYING'],
  DESTROYED: [],
};

export function canTransitionInstance(from: InstanceStatus, to: InstanceStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertInstanceTransition(from: InstanceStatus, to: InstanceStatus): void {
  if (!canTransitionInstance(from, to)) throw new InvalidTransitionError('Instance', from, to);
}

export function canStartDeployment(status: InstanceStatus): boolean {
  return (DEPLOYABLE_FROM as readonly InstanceStatus[]).includes(status);
}

export function canStartDestroy(status: InstanceStatus): boolean {
  return TRANSITIONS[status].includes('DESTROYING');
}

export function isInstanceBusy(status: InstanceStatus): boolean {
  return [
    'VALIDATING',
    'PLANNING',
    'AWAITING_APPROVAL',
    'PROVISIONING',
    'DEPLOYING',
    'CONFIGURING',
    'VERIFYING',
    'DESTROYING',
  ].includes(status);
}
