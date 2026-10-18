// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { nextWindowStart, readBackups, restoreToPointInTime } from './backups.js';

const now = new Date('2026-10-17T12:00:00Z');

function fakeRds(db: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}) {
  const sent: { name: string; input: Record<string, unknown> }[] = [];
  const client = {
    send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      sent.push({ name: cmd.constructor.name, input: cmd.input });
      switch (cmd.constructor.name) {
        case 'DescribeDBInstancesCommand':
          return { DBInstances: db ? [db] : [] };
        case 'DescribeDBSnapshotsCommand':
          return { DBSnapshots: extra.snapshots ?? [] };
        case 'DescribeDBInstanceAutomatedBackupsCommand':
          return { DBInstanceAutomatedBackups: extra.automated ?? [] };
        default:
          return {};
      }
    },
  };
  return { client, sent };
}

describe('RDS backups (open item 18)', () => {
  it('finds the next start of the backup window', () => {
    expect(nextWindowStart('03:00-03:30', now)).toBe('2026-10-18T03:00:00.000Z');
    expect(nextWindowStart('23:15-23:45', now)).toBe('2026-10-17T23:15:00.000Z');
    expect(nextWindowStart(undefined, now)).toBeUndefined();
  });

  it('reports retention, the last automated snapshot and the restore window', async () => {
    const { client } = fakeRds(
      { BackupRetentionPeriod: 7, PreferredBackupWindow: '03:00-03:30', LatestRestorableTime: new Date('2026-10-17T11:55:00Z') },
      {
        snapshots: [
          { Status: 'available', SnapshotCreateTime: new Date('2026-10-16T03:05:00Z') },
          { Status: 'available', SnapshotCreateTime: new Date('2026-10-17T03:04:00Z') },
          { Status: 'creating', SnapshotCreateTime: new Date('2026-10-17T11:00:00Z') },
        ],
        automated: [{ RestoreWindow: { EarliestTime: new Date('2026-10-10T03:00:00Z') } }],
      },
    );
    expect(await readBackups(client as never, 'ork-acme-prod-db', undefined, now)).toEqual({
      enabled: true,
      retentionDays: 7,
      lastBackupAt: '2026-10-17T03:04:00.000Z',
      nextBackupAt: '2026-10-18T03:00:00.000Z',
      earliestRestorableAt: '2026-10-10T03:00:00.000Z',
      latestRestorableAt: '2026-10-17T11:55:00.000Z',
    });
  });

  it('says so when backups are off', async () => {
    const { client } = fakeRds({ BackupRetentionPeriod: 0 });
    expect(await readBackups(client as never, 'db', undefined, now)).toEqual({ enabled: false });
  });

  it('restores to a new instance in the same network, never public', async () => {
    const { client, sent } = fakeRds({ DBInstanceClass: 'db.t4g.micro', DBSubnetGroup: { DBSubnetGroupName: 'ork-acme-sn' }, VpcSecurityGroups: [{ VpcSecurityGroupId: 'sg-1' }], TagList: [{ Key: 'platform:managed', Value: 'true' }] });
    const result = await restoreToPointInTime(client as never, 'ork-acme-prod-db', '2026-10-17T10:00:00Z', undefined, now);
    expect(result).toMatchObject({ status: 'started', reference: 'ork-acme-prod-db-r202610171200' });
    const restore = sent.find((c) => c.name === 'RestoreDBInstanceToPointInTimeCommand')!.input;
    expect(restore).toMatchObject({ SourceDBInstanceIdentifier: 'ork-acme-prod-db', DBSubnetGroupName: 'ork-acme-sn', VpcSecurityGroupIds: ['sg-1'], PubliclyAccessible: false });
    expect(restore.RestoreTime).toEqual(new Date('2026-10-17T10:00:00Z'));
    await expect(restoreToPointInTime(client as never, 'db', 'yesterday', undefined, now)).rejects.toThrow(/ISO/);
  });
});
