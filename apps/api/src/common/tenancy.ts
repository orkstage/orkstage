// SPDX-License-Identifier: AGPL-3.0-only
import type { RequestPrincipal } from '../types.js';

type Scoped = Pick<RequestPrincipal, 'platformRole' | 'memberships'>;

export function isPlatformStaff(p: Scoped): boolean {
  return Boolean(p.platformRole);
}

/**
 * Database filter limiting rows to tenants the caller belongs to. Platform staff see all
 * tenants. This is one layer of defense in depth; CASL checks on loaded records are another.
 */
export function tenantScope(p: Scoped): { tenantId?: { in: string[] } } {
  return isPlatformStaff(p) ? {} : { tenantId: { in: p.memberships.map((m) => m.tenantId) } };
}

/**
 * The caller's tenant scope narrowed by an optional `tenantId` filter from the query string.
 * Both conditions apply (AND): a requested tenant can only narrow the scope, never replace it,
 * so asking for another customer's tenant returns nothing instead of its rows.
 */
export function scopedToTenant(p: Scoped, requested?: string) {
  return { AND: [tenantScope(p), requested ? { tenantId: requested } : {}] };
}
