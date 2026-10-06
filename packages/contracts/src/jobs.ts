/** Queue names and job payloads shared by the API (producer) and worker (consumer). */
export const QUEUES = {
  deployments: 'deployments',
  health: 'health-checks',
  notifications: 'notifications',
  drift: 'drift-scans',
} as const;

/** Payloads carry ids only; the worker reloads authoritative state from the database. */
export interface DeploymentJob {
  deploymentId: string;
}

/**
 * Ask the worker to notify a tenant's responsible users. The worker resolves recipients and
 * preferences, writes in-app notifications and sends email. Keep bodies free of sensitive
 * infrastructure detail (spec §28).
 */
export interface NotificationJob {
  tenantId: string;
  event: NotificationEvent;
  title: string;
  body: string;
  /** Path in the web console, e.g. `/deployments/<id>`. */
  link?: string;
  /**
   * Machine-readable identifiers for webhook subscribers (e.g. deploymentId, instanceId,
   * status). Ids and states only — never secrets or infrastructure internals.
   */
  data?: Record<string, string | number | boolean | null>;
}

export const NOTIFICATION_EVENTS = [
  'deployment.started',
  'deployment.succeeded',
  'deployment.failed',
  'deployment.awaiting_approval',
  'instance.degraded',
  'instance.drift_detected',
  'incident.opened',
  'incident.updated',
  'incident.resolved',
  'cloud_target.unhealthy',
] as const;
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];
