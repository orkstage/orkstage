/** Failure classification shared by API responses, deployment records and incidents (spec §37). */
export const FAILURE_CLASSES = [
  'VALIDATION_ERROR',
  'AUTHENTICATION_ERROR',
  'AUTHORIZATION_ERROR',
  'PROVIDER_RATE_LIMIT',
  'NETWORK_ERROR',
  'TIMEOUT',
  'RESOURCE_CONFLICT',
  'QUOTA_EXCEEDED',
  'POLICY_VIOLATION',
  'DEPLOYMENT_ERROR',
  'HEALTH_CHECK_FAILED',
  'UNKNOWN',
] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];

/** Failure classes where an automatic retry can reasonably succeed. */
const RETRYABLE: ReadonlySet<FailureClass> = new Set([
  'PROVIDER_RATE_LIMIT',
  'NETWORK_ERROR',
  'TIMEOUT',
]);

export function isRetryable(failure: FailureClass): boolean {
  return RETRYABLE.has(failure);
}

/**
 * Error carrying a stable machine-readable code and a failure class. Messages must be safe
 * to show to users: never put secrets, credentials or raw provider payloads in them.
 */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly failureClass: FailureClass = 'UNKNOWN',
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export class InvalidTransitionError extends DomainError {
  constructor(entity: string, from: string, to: string) {
    super('INVALID_STATE_TRANSITION', `${entity} cannot transition from ${from} to ${to}.`, 'VALIDATION_ERROR', {
      entity,
      from,
      to,
    });
  }
}
