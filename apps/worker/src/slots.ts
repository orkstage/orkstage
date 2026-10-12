// SPDX-License-Identifier: AGPL-3.0-only
import type { Redis } from 'ioredis';

const SLOT_TTL_SECONDS = 60 * 60;

/** One concurrency scope a deployment needs a slot in, with its limit (0 = no limit). */
export interface SlotScope {
  key: string;
  limit: number;
}

// KEYS: one sorted set per scope (member = deployment id, score = expiry in epoch seconds).
// ARGV: deployment id, TTL seconds, then one limit per key. Expired members are dropped first, so a
// slot leaked by a crashed worker frees itself. All or nothing: no slot is taken unless every scope
// has room, and a deployment that already holds a slot (a retry) keeps it.
const ACQUIRE = `
local now = tonumber(redis.call('TIME')[1])
local ttl = tonumber(ARGV[2])
for i, key in ipairs(KEYS) do
  redis.call('ZREMRANGEBYSCORE', key, '-inf', now)
  local limit = tonumber(ARGV[i + 2])
  if limit > 0 and not redis.call('ZSCORE', key, ARGV[1]) and redis.call('ZCARD', key) >= limit then
    return 0
  end
end
for _, key in ipairs(KEYS) do
  redis.call('ZADD', key, now + ttl, ARGV[1])
  redis.call('EXPIRE', key, ttl)
end
return 1`;

/**
 * Deployment concurrency limits (spec §36), shared by every worker through Redis: per cloud
 * target, per tenant and per provider region. A deployment takes a slot in every scope it touches,
 * or none, in one atomic script.
 */
export class TargetSlots {
  constructor(private readonly redis: Redis) {}

  /** Slot keys; `v2` because earlier versions stored plain sets under `slots:target:*`. */
  static scopes(input: {
    tenantId: string;
    tenantLimit: number;
    targets: Record<string, number>;
    regions: { provider: string; region: string }[];
    regionLimit: number;
  }): SlotScope[] {
    const out: SlotScope[] = Object.entries(input.targets).map(([id, limit]) => ({ key: `slots:v2:target:${id}`, limit }));
    out.push({ key: `slots:v2:tenant:${input.tenantId}`, limit: input.tenantLimit });
    const regions = new Set(input.regions.map((r) => `${r.provider}:${r.region}`));
    for (const r of [...regions].sort()) out.push({ key: `slots:v2:region:${r}`, limit: input.regionLimit });
    return out;
  }

  async acquire(deploymentId: string, scopes: SlotScope[]): Promise<boolean> {
    if (scopes.length === 0) return true;
    const ok = await this.redis.eval(ACQUIRE, scopes.length, ...scopes.map((s) => s.key), deploymentId, SLOT_TTL_SECONDS, ...scopes.map((s) => Math.max(0, s.limit)));
    return ok === 1;
  }

  async release(deploymentId: string, scopes: SlotScope[]): Promise<void> {
    if (scopes.length === 0) return;
    const pipeline = this.redis.pipeline();
    for (const s of scopes) pipeline.zrem(s.key, deploymentId);
    await pipeline.exec();
  }
}
