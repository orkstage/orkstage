// SPDX-License-Identifier: AGPL-3.0-only
import type { BackupInfo } from '@orkstage/cloud-core';
import type { InstanceResource } from '@orkstage/database';
import { toCloudTarget } from '@orkstage/runtime';
import { randomUUID } from 'node:crypto';
import { notify, type WorkerContext } from './context.js';

/** A database is read at most this often (provider APIs cost money). */
const CHECK_EVERY_MS = 30 * 60_000;
/** Daily backups plus a margin: older than this, a backup is overdue. */
const OVERDUE_MS = 26 * 3_600_000;
/** The same problem is notified again after a day. */
const RENOTIFY_MS = 86_400_000;

export interface BackupState {
  checkedAt: string;
  enabled: boolean;
  retentionDays: number | null;
  lastBackupAt: string | null;
  nextBackupAt: string | null;
  earliestRestorableAt: string | null;
  latestRestorableAt: string | null;
  problem: string | null;
  notifiedAt?: string | null;
}

/** What is wrong with the backups, if anything: a failed last backup, or none for too long. */
export function backupProblem(info: BackupInfo, createdAt: Date, now: Date): string | null {
  if (!info.enabled) return null;
  if (info.lastFailure && (!info.lastBackupAt || Date.parse(info.lastFailure.at) > Date.parse(info.lastBackupAt))) {
    return `The last backup failed: ${info.lastFailure.message.slice(0, 200)}`;
  }
  const since = info.lastBackupAt ? Date.parse(info.lastBackupAt) : createdAt.getTime();
  return now.getTime() - since > OVERDUE_MS ? 'No backup in the last 26 hours.' : null;
}

type TargetRow = Parameters<typeof toCloudTarget>[0];

/**
 * Backups of every active database (open item 18), on the health tick: the provider's last and
 * next backup and restore window are kept on the resource, and the tenant hears about a failed or
 * overdue backup (`backup.failed`), once a day while it lasts.
 */
export class BackupMonitor {
  constructor(
    private readonly ctx: WorkerContext,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async tick(targets: Map<string, TargetRow>): Promise<void> {
    const { prisma } = this.ctx;
    const dbs = await prisma.instanceResource.findMany({ where: { status: 'ACTIVE', type: 'database.postgresql' }, include: { instance: { select: { name: true } } } });
    for (const r of dbs) await this.check(r, r.instance.name, targets.get(r.targetId));
  }

  private async check(r: InstanceResource, instanceName: string, target: TargetRow | undefined) {
    const { prisma, registry, logger } = this.ctx;
    const prev = (r.backupState ?? null) as BackupState | null;
    const now = this.now();
    if (prev && now.getTime() - Date.parse(prev.checkedAt) < CHECK_EVERY_MS) return;
    if (!target || !registry.has(r.provider)) return;
    const adapter = registry.get(r.provider);
    if (!adapter.getBackups) return;
    let info: BackupInfo | null;
    try {
      info = await adapter.getBackups(
        { target: toCloudTarget(target), region: r.region, correlationId: `backup-${randomUUID()}` },
        { resourceId: r.resourceId, serviceKind: r.type, capability: r.capability, name: r.name, providerResourceId: r.providerResourceId ?? undefined, outputs: r.outputs as never },
      );
    } catch (err) {
      logger.warn({ resourceId: r.resourceId, err: (err as Error).message }, 'backup read failed');
      return;
    }
    if (!info) return;
    const problem = backupProblem(info, r.createdAt, now);
    const notify_ =
      problem !== null && (!prev?.notifiedAt || prev.problem !== problem || now.getTime() - Date.parse(prev.notifiedAt) > RENOTIFY_MS);
    const state: BackupState = {
      checkedAt: now.toISOString(),
      enabled: info.enabled,
      retentionDays: info.retentionDays ?? null,
      lastBackupAt: info.lastBackupAt ?? null,
      nextBackupAt: info.nextBackupAt ?? null,
      earliestRestorableAt: info.earliestRestorableAt ?? null,
      latestRestorableAt: info.latestRestorableAt ?? null,
      problem,
      notifiedAt: notify_ ? now.toISOString() : problem ? (prev?.notifiedAt ?? null) : null,
    };
    await prisma.instanceResource.update({ where: { id: r.id }, data: { backupState: state as object } });
    if (notify_) {
      await notify(this.ctx, {
        tenantId: r.tenantId,
        event: 'backup.failed',
        title: `Backups of ${r.resourceId} on ${instanceName} need attention`,
        body: `${problem} Check the database with its provider; a destroy of a production instance waits for a recent backup.`,
        link: `/instances/${r.instanceId}`,
        data: { instanceId: r.instanceId, resourceId: r.resourceId },
      });
    }
  }
}
