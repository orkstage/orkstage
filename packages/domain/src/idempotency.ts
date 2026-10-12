// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';

/** JSON serialization with sorted object keys, so equal values always hash equally. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function desiredStateHash(desiredState: unknown): string {
  return sha256(stableStringify(desiredState));
}

/**
 * Operation key for provisioning commands: same tenant + instance + desired state yields the
 * same key, so a restarted worker never creates duplicate resources (spec §35).
 */
export function operationKey(tenantId: string, instanceId: string, stateHash: string): string {
  return sha256(`${tenantId}:${instanceId}:${stateHash}`);
}
