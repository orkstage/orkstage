import type { Redis } from 'ioredis';

const SLOT_TTL_SECONDS = 60 * 60;

/**
 * Per-cloud-target concurrency limits (spec §36): a deployment takes one slot on every target it
 * touches, or none. Slots live in Redis sets keyed by target so every worker shares them; the
 * TTL releases slots leaked by a crashed worker.
 */
export class TargetSlots {
  constructor(private readonly redis: Redis) {}

  async acquire(deploymentId: string, limits: Record<string, number>): Promise<boolean> {
    const taken: string[] = [];
    for (const [targetId, limit] of Object.entries(limits)) {
      const key = `slots:target:${targetId}`;
      await this.redis.sadd(key, deploymentId);
      await this.redis.expire(key, SLOT_TTL_SECONDS);
      const members = await this.redis.smembers(key);
      // Deterministic order: the earliest deployment ids hold the slots.
      const holders = members.sort().slice(0, limit);
      if (!holders.includes(deploymentId)) {
        await this.redis.srem(key, deploymentId);
        for (const t of taken) await this.redis.srem(`slots:target:${t}`, deploymentId);
        return false;
      }
      taken.push(targetId);
    }
    return true;
  }

  async release(deploymentId: string, targetIds: string[]): Promise<void> {
    for (const t of targetIds) await this.redis.srem(`slots:target:${t}`, deploymentId);
  }
}
