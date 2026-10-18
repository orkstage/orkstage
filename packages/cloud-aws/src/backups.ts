// SPDX-License-Identifier: AGPL-3.0-only
import {
  DescribeDBInstanceAutomatedBackupsCommand,
  DescribeDBInstancesCommand,
  DescribeDBSnapshotsCommand,
  RestoreDBInstanceToPointInTimeCommand,
  type RDSClient,
} from '@aws-sdk/client-rds';
import type { BackupInfo, ResourceActionDescriptor, ResourceActionResult } from '@orkstage/cloud-core';

/** Actions on an RDS database (open item 18). */
export const RDS_ACTIONS: ResourceActionDescriptor[] = [
  {
    name: 'restore',
    description:
      'Restore the database to a point in time as a new RDS instance next to it (same subnet group and security groups). OrkStage does not manage the copy: point the application at it, or delete it when done.',
    params: [{ name: 'pointInTime', type: 'string', description: 'ISO time within the restore window; the latest restorable time when empty.' }],
  },
];

/** The next start of an RDS backup window such as `03:00-03:30` (UTC), after `now`. */
export function nextWindowStart(window: string | undefined, now: Date): string | undefined {
  const m = /^(\d{2}):(\d{2})-/.exec(window ?? '');
  if (!m) return undefined;
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), Number(m[1]), Number(m[2])));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString();
}

/** Backups of one RDS instance: retention, last automated snapshot, next window, restore window. */
export async function readBackups(client: Pick<RDSClient, 'send'>, identifier: string, signal?: AbortSignal, now = new Date()): Promise<BackupInfo> {
  const opts = { abortSignal: signal };
  const db = (await client.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: identifier }), opts)).DBInstances?.[0];
  const retentionDays = db?.BackupRetentionPeriod ?? 0;
  if (!db || retentionDays === 0) return { enabled: false };
  const [snapshots, automated] = await Promise.all([
    client.send(new DescribeDBSnapshotsCommand({ DBInstanceIdentifier: identifier, SnapshotType: 'automated' }), opts),
    client.send(new DescribeDBInstanceAutomatedBackupsCommand({ DBInstanceIdentifier: identifier }), opts),
  ]);
  const last = (snapshots.DBSnapshots ?? [])
    .filter((s) => s.Status === 'available' && s.SnapshotCreateTime)
    .map((s) => new Date(s.SnapshotCreateTime!).getTime())
    .sort((a, b) => b - a)[0];
  const window = automated.DBInstanceAutomatedBackups?.[0]?.RestoreWindow;
  return {
    enabled: true,
    retentionDays,
    ...(last ? { lastBackupAt: new Date(last).toISOString() } : {}),
    ...(nextWindowStart(db.PreferredBackupWindow, now) ? { nextBackupAt: nextWindowStart(db.PreferredBackupWindow, now) } : {}),
    ...(window?.EarliestTime ? { earliestRestorableAt: new Date(window.EarliestTime).toISOString() } : {}),
    ...(db.LatestRestorableTime ? { latestRestorableAt: new Date(db.LatestRestorableTime).toISOString() } : window?.LatestTime ? { latestRestorableAt: new Date(window.LatestTime).toISOString() } : {}),
  };
}

/** Point in time restore into a new instance named after the source and the time of the request. */
export async function restoreToPointInTime(
  client: Pick<RDSClient, 'send'>,
  identifier: string,
  pointInTime: string | undefined,
  signal?: AbortSignal,
  now = new Date(),
): Promise<ResourceActionResult> {
  const opts = { abortSignal: signal };
  const db = (await client.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: identifier }), opts)).DBInstances?.[0];
  if (!db) throw new Error(`RDS instance ${identifier} not found.`);
  const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 12);
  const target = `${identifier.slice(0, 63 - 15)}-r${stamp}`;
  const time = pointInTime ? new Date(pointInTime) : undefined;
  if (time && Number.isNaN(time.getTime())) throw new Error('pointInTime must be an ISO date and time.');
  await client.send(
    new RestoreDBInstanceToPointInTimeCommand({
      SourceDBInstanceIdentifier: identifier,
      TargetDBInstanceIdentifier: target,
      ...(time ? { RestoreTime: time } : { UseLatestRestorableTime: true }),
      DBSubnetGroupName: db.DBSubnetGroup?.DBSubnetGroupName,
      VpcSecurityGroupIds: (db.VpcSecurityGroups ?? []).map((g) => g.VpcSecurityGroupId!).filter(Boolean),
      DBInstanceClass: db.DBInstanceClass,
      PubliclyAccessible: false,
      CopyTagsToSnapshot: true,
      Tags: [...(db.TagList ?? []).filter((t) => t.Key !== 'Name'), { Key: 'platform:restored-from', Value: identifier }],
    }),
    opts,
  );
  return {
    reference: target,
    status: 'started',
    message: `Restoring ${identifier} ${time ? `to ${time.toISOString()}` : 'to the latest restorable time'} as the new RDS instance ${target}. It is not managed by OrkStage.`,
  };
}
