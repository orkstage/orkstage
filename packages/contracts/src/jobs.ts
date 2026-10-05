/** Queue names and job payloads shared by the API (producer) and worker (consumer). */
export const QUEUES = {
  deployments: 'deployments',
  health: 'health-checks',
  notifications: 'notifications',
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
}

export const NOTIFICATION_EVENTS = [
  'deployment.started',
  'deployment.succeeded',
  'deployment.failed',
  'deployment.awaiting_approval',
  'instance.degraded',
  'incident.opened',
  'incident.updated',
  'incident.resolved',
  'cloud_target.unhealthy',
] as const;
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];
