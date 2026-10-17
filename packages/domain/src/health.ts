// SPDX-License-Identifier: AGPL-3.0-only
/** Health of a resource, service, instance or cloud target (spec §64). */
export const HEALTH_STATES = ['HEALTHY', 'DEGRADED', 'UNHEALTHY', 'UNKNOWN', 'MAINTENANCE'] as const;
export type HealthState = (typeof HEALTH_STATES)[number];

/** Customer-facing status page states (spec §26). */
export const STATUS_STATES = [
  'OPERATIONAL',
  'DEGRADED',
  'PARTIAL_OUTAGE',
  'MAJOR_OUTAGE',
  'MAINTENANCE',
  'UNKNOWN',
] as const;
export type StatusState = (typeof STATUS_STATES)[number];

/**
 * Whether the knowledge we hold about a resource came from intent, our own records, or the
 * provider itself (spec §93). The database saying a resource exists is only KNOWN.
 */
export const KNOWLEDGE_STATES = ['DESIRED', 'KNOWN', 'ACTUAL', 'UNKNOWN'] as const;
export type KnowledgeState = (typeof KNOWLEDGE_STATES)[number];

export interface ComponentHealth {
  componentId: string;
  state: HealthState;
  /** Critical components take the instance down with them; others only degrade it. */
  critical: boolean;
}

/**
 * Derives instance health from component health. Instance health is a policy over components,
 * not a single boolean.
 */
export function deriveInstanceHealth(components: readonly ComponentHealth[]): HealthState {
  if (components.length === 0) return 'UNKNOWN';
  if (components.every((c) => c.state === 'MAINTENANCE')) return 'MAINTENANCE';

  const active = components.filter((c) => c.state !== 'MAINTENANCE');
  if (active.some((c) => c.critical && c.state === 'UNHEALTHY')) return 'UNHEALTHY';
  if (active.some((c) => c.state === 'UNHEALTHY' || c.state === 'DEGRADED')) return 'DEGRADED';
  if (active.some((c) => c.state === 'UNKNOWN')) {
    return active.every((c) => c.state === 'UNKNOWN') ? 'UNKNOWN' : 'DEGRADED';
  }
  return 'HEALTHY';
}

export function healthToStatus(health: HealthState, critical: boolean): StatusState {
  switch (health) {
    case 'HEALTHY':
      return 'OPERATIONAL';
    case 'DEGRADED':
      return 'DEGRADED';
    case 'UNHEALTHY':
      return critical ? 'MAJOR_OUTAGE' : 'PARTIAL_OUTAGE';
    case 'MAINTENANCE':
      return 'MAINTENANCE';
    default:
      return 'UNKNOWN';
  }
}

const STATUS_SEVERITY: Record<StatusState, number> = {
  OPERATIONAL: 0,
  MAINTENANCE: 1,
  UNKNOWN: 2,
  DEGRADED: 3,
  PARTIAL_OUTAGE: 4,
  MAJOR_OUTAGE: 5,
};

/** The worst status across components, used for the status page headline. */
export function worstStatus(states: readonly StatusState[]): StatusState {
  return states.reduce<StatusState>(
    (worst, s) => (STATUS_SEVERITY[s] > STATUS_SEVERITY[worst] ? s : worst),
    'OPERATIONAL',
  );
}

/**
 * What the public status page and status emails say about an incident (open item 8). Automated
 * incidents carry internal details in their titles and updates (resource ids, rule names,
 * metric values), so outside the console they read as a plain impact on the instance; people
 * write the title and updates of manual incidents for their readers.
 */
export function publicIncidentTitle(i: { source: string; title: string; impact: string }, instanceName?: string | null): string {
  if (i.source !== 'AUTOMATED') return i.title;
  const what = i.impact === 'MAJOR_OUTAGE' ? 'Service disruption' : i.impact === 'PARTIAL_OUTAGE' ? 'Partial outage' : 'Degraded performance';
  return instanceName ? `${what} on ${instanceName}` : what;
}

/** A system update (no author) in plain words; updates written by people pass through. */
export function publicIncidentUpdate(u: { status: string; message: string; createdById: string | null }): string {
  if (u.createdById) return u.message;
  return u.status === 'RESOLVED' ? 'This incident is resolved. The service is working normally.' : 'We detected a problem and are looking into it.';
}

/** Where a maintenance window is in time. */
export function maintenanceState(w: { startsAt: Date; endsAt: Date }, now = new Date()): 'scheduled' | 'in_progress' | 'completed' {
  if (now < w.startsAt) return 'scheduled';
  return now < w.endsAt ? 'in_progress' : 'completed';
}
