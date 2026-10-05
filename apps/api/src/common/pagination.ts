import type { Page } from '@co/contracts';

/**
 * Cursor pagination over time-ordered ids (UUIDv7 / bigserial): newest first. Fetch
 * `limit + 1` rows; the extra row only signals that another page exists.
 */
export function page<T extends { id: string | bigint }, R>(rows: T[], limit: number, map: (row: T) => R): Page<R> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return { items: items.map(map), nextCursor: hasMore ? String(items[items.length - 1]!.id) : null };
}

export const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
