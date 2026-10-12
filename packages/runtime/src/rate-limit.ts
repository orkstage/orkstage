// SPDX-License-Identifier: AGPL-3.0-only
import type { Redis } from 'ioredis';

export interface RateLimitRecord {
  totalHits: number;
  /** Seconds until the window resets. */
  timeToExpire: number;
  isBlocked: boolean;
  /** Seconds until the block ends (0 when not blocked). */
  timeToBlockExpire: number;
}

/**
 * Fixed window with a block period, in one atomic script: every API instance shares the same
 * counters, so limits hold when the API scales horizontally (spec §49, §73). KEYS: hits, block.
 * ARGV: window ms, limit, block ms. Returns hits, window ms left, blocked flag, block ms left.
 */
const SCRIPT = `
local blockLeft = redis.call('PTTL', KEYS[2])
if blockLeft > 0 then
  local hits = tonumber(redis.call('GET', KEYS[1]) or ARGV[2])
  return { hits, math.max(redis.call('PTTL', KEYS[1]), 0), 1, blockLeft }
end
local hits = redis.call('INCR', KEYS[1])
if hits == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local windowLeft = redis.call('PTTL', KEYS[1])
if hits > tonumber(ARGV[2]) then
  local block = tonumber(ARGV[3])
  if block <= 0 then block = windowLeft end
  redis.call('SET', KEYS[2], '1', 'PX', block)
  return { hits, windowLeft, 1, block }
end
return { hits, windowLeft, 0, 0 }
`;

/**
 * Rate limit counters in Redis. Shaped like `@nestjs/throttler`'s `ThrottlerStorage`, so the API
 * plugs it in as the throttler storage without this package depending on Nest.
 */
export class RedisRateLimitStorage {
  constructor(
    private readonly redis: Pick<Redis, 'eval'>,
    private readonly prefix = 'ratelimit',
  ) {}

  async increment(key: string, ttl: number, limit: number, blockDuration: number, throttlerName: string): Promise<RateLimitRecord> {
    const base = `${this.prefix}:${throttlerName}:${key}`;
    const [hits, windowLeft, blocked, blockLeft] = (await this.redis.eval(SCRIPT, 2, `${base}:hits`, `${base}:block`, ttl, limit, blockDuration)) as number[];
    return {
      totalHits: Number(hits),
      timeToExpire: Math.ceil(Number(windowLeft) / 1000),
      isBlocked: Number(blocked) === 1,
      timeToBlockExpire: Math.ceil(Number(blockLeft) / 1000),
    };
  }
}
