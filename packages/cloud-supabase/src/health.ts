// SPDX-License-Identifier: AGPL-3.0-only
import type { LogLine } from '@orkstage/cloud-core';
import type { HealthState } from '@orkstage/domain';
import type { ProjectStatus, ServiceHealth } from './api.js';

const TRANSITIONAL: ReadonlySet<ProjectStatus> = new Set(['COMING_UP', 'RESTARTING', 'RESTORING', 'UPGRADING', 'RESIZING', 'PAUSING', 'UNKNOWN']);

/** Health from the project status alone; `undefined` means the services must be asked. */
export function projectHealth(status: ProjectStatus): { state: HealthState; message: string } | undefined {
  if (status === 'ACTIVE_HEALTHY') return undefined;
  if (TRANSITIONAL.has(status)) return { state: 'DEGRADED', message: `Project ${status.toLowerCase().replace(/_/g, ' ')}.` };
  if (status === 'INACTIVE') return { state: 'UNHEALTHY', message: 'Project is paused. Run the restore action to bring it back.' };
  if (status === 'ACTIVE_UNHEALTHY') return { state: 'UNHEALTHY', message: 'Supabase reports the project as unhealthy.' };
  return { state: 'UNHEALTHY', message: `Project status ${status}.` };
}

/**
 * Combines per service health. A database that is down makes the project unhealthy; other
 * services being down or still starting degrade it.
 */
export function servicesHealth(services: ServiceHealth[], critical: string): { state: HealthState; message: string } {
  if (services.length === 0) return { state: 'UNKNOWN', message: 'Supabase returned no service health.' };
  const down = services.filter((s) => s.status === 'UNHEALTHY').map((s) => s.name);
  const starting = services.filter((s) => s.status === 'COMING_UP').map((s) => s.name);
  if (down.includes(critical)) return { state: 'UNHEALTHY', message: `Unhealthy: ${down.join(', ')}.` };
  if (down.length) return { state: 'DEGRADED', message: `Unhealthy: ${down.join(', ')}.` };
  if (starting.length) return { state: 'DEGRADED', message: `Starting: ${starting.join(', ')}.` };
  return { state: 'HEALTHY', message: `Healthy: ${services.map((s) => s.name).join(', ')}.` };
}

/** Log sources of the unified logs table, per capability. */
export const LOG_SOURCES: Record<string, string> = {
  'supabase-postgres': 'postgres_logs',
  'supabase-storage': 'storage_logs',
};

/** ClickHouse SQL for the newest lines of one source (the logs endpoint caps the window at 24 hours). */
export function logsQuery(source: string, limit: number): string {
  const n = Math.max(1, Math.min(1000, Math.floor(limit)));
  return `select timestamp, event_message from logs where source_name = '${source}' order by timestamp desc limit ${n}`;
}

/** Log timestamps arrive as ISO strings or as epoch microseconds. */
export function toIso(ts: unknown): string {
  const n = typeof ts === 'number' ? ts : typeof ts === 'string' && /^\d+$/.test(ts) ? Number(ts) : undefined;
  if (n !== undefined) return new Date(n > 1e14 ? n / 1000 : n > 1e11 ? n : n * 1000).toISOString();
  const d = new Date(String(ts));
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function levelOf(message: string): LogLine['level'] {
  if (/\b(ERROR|FATAL|PANIC)\b/i.test(message)) return 'error';
  if (/\bWARN(ING)?\b/i.test(message)) return 'warn';
  if (/\bDEBUG\b/i.test(message)) return 'debug';
  return 'info';
}

export function toLogLines(rows: unknown[], source: string): LogLine[] {
  return rows.map((r) => {
    const row = (r ?? {}) as Record<string, unknown>;
    const message = String(row.event_message ?? '');
    return { timestamp: toIso(row.timestamp), level: levelOf(message), message, attributes: { source } };
  });
}
