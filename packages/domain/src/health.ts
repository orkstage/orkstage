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
