// SPDX-License-Identifier: AGPL-3.0-only
/** Queue names and job payloads shared by the API (producer) and worker (consumer). */
export const QUEUES = {
  deployments: 'deployments',
  health: 'health-checks',
  notifications: 'notifications',
  drift: 'drift-scans',
  triggers: 'triggers',
  emails: 'emails',
} as const;

/** W3C trace context of whoever queued the job, so the worker's span continues that trace. */
export interface Traced {
  _trace?: Record<string, string>;
}

/** Payloads carry ids only; the worker reloads authoritative state from the database. */
export interface DeploymentJob extends Traced {
  deploymentId: string;
}

/**
 * Run a template trigger. `runId` for runs created by the API; scheduled runs carry the instance
 * and trigger name and the worker records the run itself.
 */
export type TriggerJob = ({ runId: string } | { instanceId: string; trigger: string }) & Traced;

/**
 * A one off email to someone who is not (yet) a member, such as an invitation. The job carries
 * the invitation link, so it is removed from the queue as soon as it is sent or gives up.
 */
export interface InvitationEmailJob extends Traced {
  kind: 'invitation';
  to: string;
  tenantName: string;
  inviterName: string;
  role: string;
  link: string;
  expiresAt: string;
}

/** An update to the confirmed subscribers of a status page, or a confirmation link to a new one. */
export interface StatusEmailJob extends Traced {
  kind: 'status';
  to: string;
  subject: string;
  text: string;
}

/**
 * Ask the worker to notify a tenant's responsible users. The worker resolves recipients and
 * preferences, writes in-app notifications and sends email. Keep bodies free of sensitive
 * infrastructure detail (spec §28).
 */
export interface NotificationJob extends Traced {
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
  /** The operation that caused it (a deployment, a trigger run), for following it across logs and webhooks. */
  correlationId?: string;
}

export const NOTIFICATION_EVENTS = [
  'deployment.started',
  'deployment.succeeded',
  'deployment.failed',
  'deployment.awaiting_approval',
  'deployment.bake_failed',
  'instance.degraded',
  'instance.drift_detected',
  'trigger.succeeded',
  'trigger.failed',
  'trigger.awaiting_approval',
  'incident.opened',
  'incident.updated',
  'incident.resolved',
  'maintenance.scheduled',
  'maintenance.started',
  'maintenance.completed',
  'domain.verified',
  'domain.verification_failed',
  'domain.certificate_issued',
  'domain.certificate_expiring',
  'cloud_target.unhealthy',
  'service.unhealthy',
  'quota.exceeded',
  'backup.failed',
] as const;
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];
