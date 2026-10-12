// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';

export const PLATFORM_PREFIX = 'ork';

/** Lowercase, dash-separated, alphanumeric slug. */
export function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Deterministic physical resource name: {platform}-{tenant}-{instance}-{resource}. When the
 * result exceeds the provider limit, the middle is truncated and a short hash of the full
 * name is appended, so names stay unique and stable across runs (spec §91).
 */
export function resourceName(
  parts: { tenantSlug: string; instanceSlug: string; resourceId: string },
  maxLength = 63,
): string {
  const full = [PLATFORM_PREFIX, parts.tenantSlug, parts.instanceSlug, slugify(parts.resourceId)]
    .map(slugify)
    .filter(Boolean)
    .join('-');
  return fitName(full, maxLength);
}

/**
 * Shortens a name to a provider limit, keeping it unique and stable with a hash suffix of the
 * full name. Use per service (e.g. ALB names are limited to 32 characters).
 */
export function fitName(name: string, maxLength: number): string {
  if (name.length <= maxLength) return name;
  const hash = createHash('sha256').update(name).digest('hex').slice(0, 8);
  return `${name.slice(0, maxLength - hash.length - 1).replace(/-+$/, '')}-${hash}`;
}
