// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Uptime from health check history (spec §42, open item 11). A check counts as up when the
 * resource was healthy or degraded (still serving), and as down when it was unhealthy. Unknown
 * results and planned maintenance count neither way.
 */
export const UP_STATES = ['HEALTHY', 'DEGRADED'] as const;
export const COUNTED_STATES = ['HEALTHY', 'DEGRADED', 'UNHEALTHY'] as const;

/** Checks of one resource on one UTC day, as the grouped history query returns them. */
export interface UptimeRow {
  resourceId: string;
  /** `YYYY-MM-DD` (UTC). */
  day: string;
  up: number;
  total: number;
}

export interface UptimeDay {
  day: string;
  /** Percent from 0 to 100, two decimals; null when there were no counted checks. */
  uptime: number | null;
}

const percent = (up: number, total: number) => (total === 0 ? null : Math.round((up / total) * 10_000) / 100);

/** The last `days` UTC days, oldest first, ending today. */
export function uptimeDays(days: number, now = new Date()): string[] {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Array.from({ length: days }, (_, i) => new Date(today - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10));
}

/** Daily and overall uptime of a set of resources (a component, or a whole instance). */
export function uptimeOf(rows: UptimeRow[], resourceIds: readonly string[], days: string[]): { overall: number | null; days: UptimeDay[] } {
  const mine = rows.filter((r) => resourceIds.includes(r.resourceId));
  let up = 0;
  let total = 0;
  const byDay = days.map((day) => {
    const d = mine.filter((r) => r.day === day);
    const u = d.reduce((s, r) => s + r.up, 0);
    const t = d.reduce((s, r) => s + r.total, 0);
    up += u;
    total += t;
    return { day, uptime: percent(u, t) };
  });
  return { overall: percent(up, total), days: byDay };
}
