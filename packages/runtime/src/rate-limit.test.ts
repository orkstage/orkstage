// SPDX-License-Identifier: AGPL-3.0-only
import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import { RedisRateLimitStorage } from './rate-limit.js';

// Runs against a real Redis (CI provides one; locally `pnpm local:up` in orkstage-dev).
const url = process.env.REDIS_URL;

describe.skipIf(!url)('RedisRateLimitStorage', () => {
  const redis = new Redis(url ?? 'redis://localhost:6379', { lazyConnect: true });
  afterAll(() => redis.quit());

  it('counts hits across instances and blocks past the limit', async () => {
    const key = `test-${Date.now()}-${Math.random()}`;
    const a = new RedisRateLimitStorage(redis, 'ratelimit-test');
    const b = new RedisRateLimitStorage(redis, 'ratelimit-test');
    const results = [];
    for (let i = 0; i < 3; i++) results.push(await (i % 2 ? a : b).increment(key, 60_000, 2, 30_000, 'default'));
    expect(results.map((r) => [r.totalHits, r.isBlocked])).toEqual([
      [1, false],
      [2, false],
      [3, true],
    ]);
    expect(results[2]!.timeToBlockExpire).toBeGreaterThan(25);
    const again = await a.increment(key, 60_000, 2, 30_000, 'default');
    expect(again.isBlocked).toBe(true);
  });

  it('keeps separate windows per throttler name', async () => {
    const key = `test-${Date.now()}-${Math.random()}`;
    const s = new RedisRateLimitStorage(redis, 'ratelimit-test');
    expect((await s.increment(key, 1000, 1, 0, 'default')).isBlocked).toBe(false);
    expect((await s.increment(key, 1000, 1, 0, 'strict')).isBlocked).toBe(false);
    expect((await s.increment(key, 1000, 1, 0, 'default')).isBlocked).toBe(true);
  });
});
