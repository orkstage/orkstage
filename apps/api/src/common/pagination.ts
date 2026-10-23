// SPDX-License-Identifier: AGPL-3.0-only
import type { Page } from '@orkstage/contracts';
import { AppError } from './errors.js';

/**
 * Cursor pagination over time-ordered ids (UUIDv7 / bigserial): newest first. Fetch
 * `limit + 1` rows; the extra row only signals that another page exists.
 */
export function page<T extends { id: string | bigint }, R>(rows: T[], limit: number, map: (row: T) => R): Page<R> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return { items: items.map(map), nextCursor: hasMore ? String(items[items.length - 1]!.id) : null };
}

/**
 * Prisma order of a list from `sort` (`name`, or `-createdAt` for descending), limited to the fields
 * the list allows (public name to column). The id breaks ties, so a cursor always continues where the
 * last page ended; `createdAt` usually maps to the id itself (UUIDv7 ids sort by creation time).
 */
export function listOrder(sort: string | undefined, fields: Readonly<Record<string, string>>, fallback: string): never {
  const value = sort ?? fallback;
  const descending = value.startsWith('-');
  const column = fields[descending ? value.slice(1) : value];
  if (!column) throw new AppError(400, 'INVALID_SORT', `Sort by ${Object.keys(fields).join(', ')}, with a leading - for descending order.`);
  const direction = descending ? 'desc' : 'asc';
  return (column === 'id' ? [{ id: direction }] : [{ [column]: direction }, { id: direction }]) as never;
}

/** `take` and `cursor` for Prisma: the extra row only tells whether another page exists. */
export function pageArgs(q: { limit: number; cursor?: string }) {
  return { take: q.limit + 1, ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}) };
}

export const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
