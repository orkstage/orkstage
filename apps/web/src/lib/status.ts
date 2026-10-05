export type Tone = 'ok' | 'warn' | 'danger' | 'info' | 'neutral' | 'accent';

/**
 * One vocabulary of status colors for the whole console: operational/healthy green, degraded
 * amber, outage/unhealthy/failed red, maintenance/in-progress blue, unknown/inactive gray.
 */
const TONES: Record<string, Tone> = {
  // health + status page
  HEALTHY: 'ok',
  OPERATIONAL: 'ok',
  DEGRADED: 'warn',
  PARTIAL_OUTAGE: 'danger',
  MAJOR_OUTAGE: 'danger',
  UNHEALTHY: 'danger',
  MAINTENANCE: 'info',
  UNKNOWN: 'neutral',
  // instance lifecycle
  DRAFT: 'neutral',
  VALIDATING: 'info',
  PLANNING: 'info',
  AWAITING_APPROVAL: 'warn',
  PROVISIONING: 'info',
  DEPLOYING: 'info',
  CONFIGURING: 'info',
  VERIFYING: 'info',
  READY: 'ok',
  VALIDATION_FAILED: 'danger',
  PLAN_FAILED: 'danger',
  PROVISION_FAILED: 'danger',
  DEPLOY_FAILED: 'danger',
  VERIFICATION_FAILED: 'danger',
  DESTROYING: 'info',
  DESTROY_FAILED: 'danger',
  DESTROYED: 'neutral',
  // deployments + steps
  QUEUED: 'neutral',
  RUNNING: 'info',
  SUCCEEDED: 'ok',
  FAILED: 'danger',
  PARTIALLY_FAILED: 'warn',
  CANCELLED: 'neutral',
  PENDING: 'neutral',
  SKIPPED: 'neutral',
  // resources
  ACTIVE: 'ok',
  DELETED: 'neutral',
  DISABLED: 'neutral',
  // drift
  IN_SYNC: 'ok',
  DRIFT_DETECTED: 'warn',
  REMEDIATION_PENDING: 'info',
  REMEDIATION_FAILED: 'danger',
  // knowledge
  DESIRED: 'neutral',
  KNOWN: 'info',
  ACTUAL: 'ok',
  // templates
  PUBLISHED: 'ok',
  DEPRECATED: 'neutral',
  // incidents
  INVESTIGATING: 'danger',
  IDENTIFIED: 'warn',
  MONITORING: 'info',
  RESOLVED: 'ok',
  // checks / policy / audit results
  PASS: 'ok',
  OK: 'ok',
  SUCCESS: 'ok',
  ALLOWED: 'ok',
  WARN: 'warn',
  WARNING: 'warn',
  MISSING: 'warn',
  FAIL: 'danger',
  FAILURE: 'danger',
  ERROR: 'danger',
  DENIED: 'danger',
  FORBIDDEN: 'danger',
  // image scans
  PASSED: 'ok',
  CLEAN: 'ok',
  VULNERABLE: 'danger',
  NOT_SCANNED: 'neutral',
  // severities
  LOW: 'neutral',
  MEDIUM: 'warn',
  HIGH: 'danger',
  CRITICAL: 'danger',
};

export function toneOf(status: string | null | undefined): Tone {
  if (!status) return 'neutral';
  return TONES[status.toUpperCase()] ?? 'neutral';
}

const LABELS: Record<string, string> = {
  OPERATIONAL: 'Operational',
  PARTIAL_OUTAGE: 'Partial outage',
  MAJOR_OUTAGE: 'Major outage',
  AWAITING_APPROVAL: 'Awaiting approval',
  PARTIALLY_FAILED: 'Partially failed',
  DRIFT_DETECTED: 'Drift detected',
  IN_SYNC: 'In sync',
};

export function statusLabel(status: string | null | undefined): string {
  if (!status) return 'Unknown';
  const fixed = LABELS[status.toUpperCase()];
  if (fixed) return fixed;
  const s = status.replace(/_/g, ' ').toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export const ACTIVE_DEPLOYMENT_STATUSES = ['QUEUED', 'RUNNING', 'AWAITING_APPROVAL'] as const;

export function isDeploymentActive(status: string | null | undefined): boolean {
  return !!status && (ACTIVE_DEPLOYMENT_STATUSES as readonly string[]).includes(status);
}

const TRANSITIONAL_INSTANCE = ['VALIDATING', 'PLANNING', 'AWAITING_APPROVAL', 'PROVISIONING', 'DEPLOYING', 'CONFIGURING', 'VERIFYING', 'DESTROYING'];

export function isInstanceTransitional(status: string | null | undefined): boolean {
  return !!status && TRANSITIONAL_INSTANCE.includes(status);
}

/** Banner copy for the overall state of a status page. */
export function overallHeadline(overall: string): string {
  switch (overall.toUpperCase()) {
    case 'OPERATIONAL':
      return 'All systems operational';
    case 'DEGRADED':
      return 'Degraded performance';
    case 'PARTIAL_OUTAGE':
      return 'Partial outage';
    case 'MAJOR_OUTAGE':
      return 'Major outage';
    case 'MAINTENANCE':
      return 'Scheduled maintenance in progress';
    default:
      return 'Status unknown';
  }
}
