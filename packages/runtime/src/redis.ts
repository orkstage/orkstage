import { Redis } from 'ioredis';

/** BullMQ requires maxRetriesPerRequest = null on connections used by workers. */
export function createRedis(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: null, enableReadyCheck: true });
}
