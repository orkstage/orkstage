// SPDX-License-Identifier: AGPL-3.0-only
import { AdapterRegistry } from '@orkstage/cloud-core';
import { InMemoryMockStateStore, MockAdapter } from '@orkstage/cloud-mock';
import type { InstanceResource } from '@orkstage/database';
import { describe, expect, it } from 'vitest';
import { BackupMonitor, backupProblem, type BackupState } from './backups.js';
import type { WorkerContext } from './context.js';

const now = new Date('2026-10-17T12:00:00Z');
const days = (n: number) => new Date(now.getTime() + n * 86_400_000).toISOString();

describe('backup problems (open item 18)', () => {
  const old = new Date('2026-09-01T00:00:00Z');
  it('reports a failure newer than the last backup, and overdue backups', () => {
    expect(backupProblem({ enabled: true, lastBackupAt: days(-0.5) }, old, now)).toBeNull();
    expect(backupProblem({ enabled: true, lastBackupAt: days(-2) }, old, now)).toBe('No backup in the last 26 hours.');
    expect(backupProblem({ enabled: true, lastBackupAt: days(-1.5), lastFailure: { at: days(-0.5), message: 'storage full' } }, old, now)).toBe('The last backup failed: storage full');
    expect(backupProblem({ enabled: false }, old, now)).toBeNull();
    // A database created an hour ago has no backup yet, and that is fine.
    expect(backupProblem({ enabled: true }, new Date(now.getTime() - 3_600_000), now)).toBeNull();
  });
});

describe('backup monitor', () => {
  it('keeps the provider state on the resource and warns once per problem', async () => {
    const target = { id: 't-sim', provider: 'mock', name: 'Simulated AWS', config: { simulate: 'aws' }, credentialRef: null, allowedRegions: ['us-east-1'], defaultRegion: 'us-east-1' };
    const db = {
      id: 'r1',
      tenantId: 'tenant-1',
      instanceId: 'i1',
      resourceId: 'database',
      type: 'database.postgresql',
      provider: 'mock',
      targetId: 't-sim',
      region: 'us-east-1',
      capability: 'rds-postgres',
      name: 'ork-acme-prod-db',
      status: 'ACTIVE',
      createdAt: new Date('2026-09-01T00:00:00Z'),
      outputs: { backup_retention_days: 7 },
      backupState: null as BackupState | null,
      instance: { name: 'Acme production' },
    };
    const events: string[] = [];
    const prisma = {
      instanceResource: {
        findMany: async () => [db],
        update: async ({ data }: { data: { backupState: BackupState } }) => void (db.backupState = data.backupState),
      },
    };
    const mock = new MockAdapter(new InMemoryMockStateStore(), { sleep: async () => {} });
    const ctx = { prisma, registry: new AdapterRegistry().register(mock), logger: { warn: () => {} }, notifications: { add: async (_n: string, job: { event: string }) => void events.push(job.event) } } as unknown as WorkerContext;
    let clock = Date.now();
    const monitor = new BackupMonitor(ctx, () => new Date(clock));
    const targets = new Map([[target.id, target as never]]);

    await monitor.tick(targets);
    expect(db.backupState).toMatchObject({ enabled: true, retentionDays: 7, problem: null });
    expect(db.backupState!.lastBackupAt).toBeTruthy();
    expect(events).toEqual([]);

    await mock.setBackupFailure(db.name, 'storage full');
    clock += 31 * 60_000;
    await monitor.tick(targets);
    expect(db.backupState!.problem).toBe('The last backup failed: storage full');
    expect(events).toEqual(['backup.failed']);

    clock += 31 * 60_000;
    await monitor.tick(targets);
    expect(events).toEqual(['backup.failed']); // same problem, already said today
    void (db as unknown as InstanceResource);
  });
});
