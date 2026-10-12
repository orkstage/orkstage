// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import type { WorkerContext } from './context.js';
import { Housekeeping } from './housekeeping.js';

function context(data: {
  incidents?: { id: string; tenantId: string; title: string; dedupKey: string }[];
  instances?: Record<string, string>;
  resources?: Record<string, string>;
  deployments?: { id: string }[];
  lastEvent?: Record<string, Date>;
}) {
  const updated: string[] = [];
  const prisma = {
    incident: {
      findMany: async () => data.incidents ?? [],
      update: async ({ where }: { where: { id: string } }) => void updated.push(where.id),
    },
    instance: { findUnique: async ({ where }: { where: { id: string } }) => (data.instances?.[where.id] ? { status: data.instances[where.id] } : null) },
    instanceResource: {
      findUnique: async ({ where }: { where: { instanceId_resourceId: { instanceId: string; resourceId: string } } }) => {
        const s = data.resources?.[`${where.instanceId_resourceId.instanceId}/${where.instanceId_resourceId.resourceId}`];
        return s ? { status: s } : null;
      },
    },
    auditEvent: { create: async () => ({}) },
    healthCheckResult: { deleteMany: vi.fn(async () => ({ count: 3 })) },
    deployment: { findMany: async () => data.deployments ?? [] },
    deploymentEvent: { findFirst: async ({ where }: { where: { deploymentId: string } }) => (data.lastEvent?.[where.deploymentId] ? { at: data.lastEvent[where.deploymentId] } : null) },
  };
  const ctx = {
    prisma,
    config: { HEALTH_HISTORY_DAYS: 30, TOFU_TIMEOUT_MINUTES: 45 },
    notifications: { add: async () => ({}) },
  } as unknown as WorkerContext;
  return { ctx, updated, prisma };
}

describe('Housekeeping', () => {
  it('resolves automated incidents of destroyed instances and removed resources only', async () => {
    const { ctx, updated } = context({
      incidents: [
        { id: 'gone-instance', tenantId: 't', title: 'API down', dedupKey: 'health:i1:api' },
        { id: 'gone-resource', tenantId: 't', title: 'Cache down', dedupKey: 'health:i2:cache' },
        { id: 'still-live', tenantId: 't', title: 'DB down', dedupKey: 'health:i2:db' },
      ],
      instances: { i1: 'DESTROYED', i2: 'READY' },
      resources: { 'i1/api': 'DELETED', 'i2/cache': 'DELETED', 'i2/db': 'ACTIVE' },
    });
    const h = new Housekeeping(ctx, { getJobs: async () => [] } as never, async () => {});
    expect(await h.resolveOrphanIncidents()).toBe(2);
    expect(updated).toEqual(['gone-instance', 'gone-resource']);
  });

  it('deletes health history past the retention period', async () => {
    const { ctx, prisma } = context({});
    const h = new Housekeeping(ctx, { getJobs: async () => [] } as never, async () => {});
    const now = new Date('2026-10-11T00:00:00Z');
    expect(await h.pruneHealthHistory(now)).toBe(3);
    expect(prisma.healthCheckResult.deleteMany).toHaveBeenCalledWith({ where: { checkedAt: { lt: new Date('2026-09-11T00:00:00Z') } } });
  });

  it('fails running deployments with no live job and no recent progress', async () => {
    const now = new Date('2026-10-11T12:00:00Z');
    const { ctx } = context({
      deployments: [{ id: 'live-job' }, { id: 'recent-event' }, { id: 'stuck' }],
      lastEvent: { 'recent-event': new Date('2026-10-11T11:50:00Z'), stuck: new Date('2026-10-11T09:00:00Z') },
    });
    const abandon = vi.fn(async () => {});
    const h = new Housekeeping(ctx, { getJobs: async () => [{ data: { deploymentId: 'live-job' } }] } as never, abandon);
    expect(await h.reapStuckDeployments(now)).toBe(1);
    expect(abandon).toHaveBeenCalledWith('stuck', expect.stringContaining('stopped'));
  });
});
