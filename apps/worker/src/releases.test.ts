// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerContext } from './context.js';
import { ReleaseWatcher } from './releases.js';

const runtime = vi.hoisted(() => ({
  rollbackTarget: vi.fn(),
  recordRollback: vi.fn(),
}));
vi.mock('@orkstage/runtime', () => ({
  InstanceBusyError: class InstanceBusyError extends Error {},
  rollbackTarget: runtime.rollbackTarget,
  recordRollback: runtime.recordRollback,
  toCloudTarget: (row: unknown) => row,
}));

const NOW = new Date('2026-10-24T12:00:00Z');
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

interface Row {
  id: string;
  instanceId: string;
  tenantId: string;
  correlationId: string;
  queuedAt: Date;
  finishedAt: Date;
  bakeUntil: Date;
  verifiedAt: Date | null;
  bakeFailedAt: Date | null;
  bakeFailure?: string | null;
  release: { strategy: string; trafficPercent: number; bakeMinutes: number; autoRollback: boolean };
  resolved: unknown;
}

function setup(o: { deployment: Partial<Row>; incident?: { title: string }; failing?: { resourceId: string; consecutiveHealthFailures: number }; newer?: boolean }) {
  const d: Row = {
    id: 'd2',
    instanceId: 'i1',
    tenantId: 't1',
    correlationId: 'c1',
    queuedAt: minutesAgo(20),
    finishedAt: minutesAgo(15),
    bakeUntil: minutesAgo(-5),
    verifiedAt: null,
    bakeFailedAt: null,
    release: { strategy: 'rolling', trafficPercent: 10, bakeMinutes: 20, autoRollback: true },
    resolved: { resources: [{ id: 'api', type: 'compute.container-service', provider: 'mock', targetId: 'tg', region: 'us-east-1', capability: 'ecs-fargate', name: 'ork-api' }] },
    ...o.deployment,
  };
  const events: { level: string; message: string }[] = [];
  const updates: Record<string, unknown>[] = [];
  const notified: { event: string; data?: Record<string, unknown> }[] = [];
  const queued: string[] = [];
  const promoted: string[] = [];
  const prisma = {
    deployment: {
      findMany: async () => [d],
      findFirst: async () => (o.newer ? { id: 'd3' } : null),
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data);
        Object.assign(d, data);
        return { count: 1 };
      },
      update: async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data);
        return Object.assign(d, data);
      },
    },
    incident: { findFirst: async () => o.incident ?? null },
    instanceResource: { findFirst: async () => (o.failing ? { ...o.failing } : null), updateMany: async () => ({ count: 1 }) },
    instance: { findUniqueOrThrow: async () => ({ id: 'i1', tenantId: 't1', environment: 'production' }) },
    cloudTarget: { findUniqueOrThrow: async () => ({ id: 'tg' }) },
    deploymentEvent: { create: async ({ data }: { data: { level: string; message: string } }) => void events.push(data) },
    auditEvent: { create: async () => ({}) },
  };
  const adapter = {
    promoteRelease: async (_ctx: unknown, ref: { resourceId: string }) => void promoted.push(ref.resourceId),
    getResource: async () => ({ exists: true, outputs: { traffic_percent: 100 } }),
  };
  const ctx = {
    prisma,
    registry: { has: () => true, get: () => adapter },
    logger: { warn: () => {} },
    notifications: { add: async (_name: string, job: { event: string; data?: Record<string, unknown> }) => void notified.push(job) },
  } as unknown as WorkerContext;
  const queue = { add: async (_name: string, job: { deploymentId: string }) => void queued.push(job.deploymentId) };
  return { watcher: new ReleaseWatcher(ctx, queue as never), d, events, updates, notified, queued, promoted };
}

beforeEach(() => {
  runtime.rollbackTarget.mockReset();
  runtime.recordRollback.mockReset();
});

describe('ReleaseWatcher (ADR 0009)', () => {
  it('keeps watching a healthy release until its bake period ends', async () => {
    const s = setup({ deployment: {} });
    await s.watcher.run(NOW);
    expect(s.updates).toEqual([]);
    expect(s.queued).toEqual([]);
  });

  it('verifies a release that stayed healthy and promotes a canary', async () => {
    const s = setup({ deployment: { bakeUntil: minutesAgo(1), release: { strategy: 'canary', trafficPercent: 10, bakeMinutes: 15, autoRollback: true } } });
    await s.watcher.run(NOW);
    expect(s.d.verifiedAt).toEqual(NOW);
    expect(s.promoted).toEqual(['api']);
    expect(s.events.at(-1)?.message).toMatch(/Verified: healthy through the 15 minute bake period; the new release now takes all traffic on 1 service/);
  });

  it('rolls back to the last verified deployment when an incident opens during the bake period', async () => {
    runtime.rollbackTarget.mockResolvedValue({ ok: true, deployment: { id: 'd1' } });
    runtime.recordRollback.mockResolvedValue({ id: 'r1' });
    const s = setup({ deployment: {}, incident: { title: 'API unavailable on Shop' } });
    await s.watcher.run(NOW);
    expect(runtime.rollbackTarget).toHaveBeenCalledWith(expect.anything(), 'i1', { before: s.d.queuedAt });
    expect(runtime.recordRollback).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ requestedById: null, requestedBy: 'automatic rollback' }));
    expect(s.queued).toEqual(['r1']);
    expect(s.d.bakeFailedAt).toEqual(NOW);
    expect(s.d.bakeFailure).toMatch(/An incident opened during the bake period: API unavailable on Shop\. Rolling back to deployment d1 \(rollback r1\)\./);
    expect(s.notified).toEqual([expect.objectContaining({ event: 'deployment.bake_failed', data: expect.objectContaining({ rolledBack: true, rollbackDeploymentId: 'r1' }) })]);
  });

  it('fails the bake on a critical service failing its checks, and says when nothing can be rolled back to', async () => {
    runtime.rollbackTarget.mockResolvedValue({ ok: false, reason: 'No earlier deployment stayed healthy through its bake period.' });
    const s = setup({ deployment: {}, failing: { resourceId: 'api', consecutiveHealthFailures: 3 } });
    await s.watcher.run(NOW);
    expect(runtime.recordRollback).not.toHaveBeenCalled();
    expect(s.d.bakeFailure).toMatch(/api failed 3 health checks in a row.*Not rolled back automatically: No earlier deployment/);
    expect(s.notified[0]).toMatchObject({ event: 'deployment.bake_failed', data: { rolledBack: false } });
  });

  it('leaves the rollback to people when automatic rollback is off', async () => {
    const s = setup({ deployment: { release: { strategy: 'rolling', trafficPercent: 10, bakeMinutes: 20, autoRollback: false } }, incident: { title: 'API down' } });
    await s.watcher.run(NOW);
    expect(runtime.rollbackTarget).not.toHaveBeenCalled();
    expect(s.d.bakeFailure).toMatch(/Automatic rollback is off/);
  });

  it('stops watching when a newer deployment started', async () => {
    const s = setup({ deployment: {}, incident: { title: 'API down' }, newer: true });
    await s.watcher.run(NOW);
    expect(s.d.bakeFailedAt).toBeNull();
    expect(s.updates).toEqual([{ bakeUntil: null, bakeFailure: 'Watching stopped: a newer deployment started.' }]);
  });
});
