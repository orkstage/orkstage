// SPDX-License-Identifier: AGPL-3.0-only
import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import { TargetSlots } from './slots.js';

// Runs against a real Redis (CI provides one; locally `pnpm local:up` in orkstage-dev).
const url = process.env.REDIS_URL;

describe('TargetSlots.scopes', () => {
  it('has one scope per target, the tenant and each distinct provider region', () => {
    const scopes = TargetSlots.scopes({
      tenantId: 't1',
      tenantLimit: 5,
      targets: { a: 2, b: 1 },
      regions: [
        { provider: 'aws', region: 'us-east-1' },
        { provider: 'aws', region: 'us-east-1' },
        { provider: 'azure', region: 'eastus' },
      ],
      regionLimit: 20,
    });
    expect(scopes).toEqual([
      { key: 'slots:v2:target:a', limit: 2 },
      { key: 'slots:v2:target:b', limit: 1 },
      { key: 'slots:v2:tenant:t1', limit: 5 },
      { key: 'slots:v2:region:aws:us-east-1', limit: 20 },
      { key: 'slots:v2:region:azure:eastus', limit: 20 },
    ]);
  });
});

describe.skipIf(!url)('TargetSlots on Redis', () => {
  const redis = new Redis(url ?? 'redis://localhost:6379', { lazyConnect: true });
  afterAll(() => redis.quit());
  const prefix = `test-${Date.now()}-${Math.random()}`;
  const scope = (name: string, limit: number) => ({ key: `${prefix}:${name}`, limit });

  it('is all or nothing across scopes and lets a holder retry', async () => {
    const slots = new TargetSlots(redis);
    const target = scope('target', 2);
    const tenant = scope('tenant', 1);
    expect(await slots.acquire('d1', [target, tenant])).toBe(true);
    // The tenant is full: d2 gets nothing, not even the free target slot.
    expect(await slots.acquire('d2', [target, tenant])).toBe(false);
    expect(await redis.zcard(target.key)).toBe(1);
    // A retry by the holder keeps its slot.
    expect(await slots.acquire('d1', [target, tenant])).toBe(true);
    await slots.release('d1', [target, tenant]);
    expect(await slots.acquire('d2', [target, tenant])).toBe(true);
    await slots.release('d2', [target, tenant]);
  });

  it('never exceeds a limit under concurrent acquisition', async () => {
    const slots = new TargetSlots(redis);
    const target = scope('race', 3);
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => slots.acquire(`r${i}`, [target])));
    expect(results.filter(Boolean)).toHaveLength(3);
    expect(await redis.zcard(target.key)).toBe(3);
  });

  it('treats 0 as no limit and frees expired slots', async () => {
    const slots = new TargetSlots(redis);
    const open = scope('open', 0);
    for (let i = 0; i < 5; i++) expect(await slots.acquire(`o${i}`, [open])).toBe(true);
    const leaked = scope('leaked', 1);
    await redis.zadd(leaked.key, 1, 'crashed-worker');
    expect(await slots.acquire('fresh', [leaked])).toBe(true);
  });
});
