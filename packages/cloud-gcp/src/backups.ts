// SPDX-License-Identifier: AGPL-3.0-only
import type { BackupInfo, ResourceOutputs } from '@orkstage/cloud-core';
import type { GcpApi } from './auth.js';

interface SqlInstance {
  settings?: {
    backupConfiguration?: {
      enabled?: boolean;
      /** Start of the daily backup window, `HH:MM` in UTC. */
      startTime?: string;
      backupRetentionSettings?: { retainedBackups?: number; retentionUnit?: string };
    };
  };
}

interface BackupRun {
  status?: string;
  type?: string;
  endTime?: string;
  enqueuedTime?: string;
  error?: { message?: string };
}

const iso = (t: string | undefined) => (t && !Number.isNaN(Date.parse(t)) ? new Date(t).toISOString() : undefined);

/** The next start of a daily `HH:MM` (UTC) backup window after `now`. */
export function nextDailyWindow(startTime: string | undefined, now: Date): string | undefined {
  const m = /^(\d{2}):(\d{2})$/.exec(startTime ?? '');
  if (!m) return undefined;
  const next = new Date(now);
  next.setUTCHours(Number(m[1]), Number(m[2]), 0, 0);
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString();
}

/**
 * Backups of a Cloud SQL for PostgreSQL instance (open item 18): the backup configuration of the
 * instance and its recent backup runs. Automated backups run once a day, so a retention of N
 * backups is N days. The restore window is not returned: Cloud SQL does not expose its start.
 */
export async function readGcpBackups(api: GcpApi, outputs: ResourceOutputs, projectId: string, now = new Date()): Promise<BackupInfo | null> {
  if (!outputs.instance_name) return null;
  const base = `https://sqladmin.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/instances/${encodeURIComponent(String(outputs.instance_name))}`;
  const instance = await api<SqlInstance>(base, { allow404: true });
  if (!instance) return null;
  const config = instance.settings?.backupConfiguration ?? {};
  if (!config.enabled) return { enabled: false };
  const runs = (await api<{ items?: BackupRun[] }>(`${base}/backupRuns?maxResults=20`))?.items ?? [];
  const at = (run: BackupRun) => iso(run.endTime) ?? iso(run.enqueuedTime);
  const latest = (status: string) =>
    runs
      .filter((run) => run.status === status && at(run))
      .sort((a, b) => Date.parse(at(b)!) - Date.parse(at(a)!))[0];
  const ok = latest('SUCCESSFUL');
  const failed = latest('FAILED');
  const retention = config.backupRetentionSettings;
  const next = nextDailyWindow(config.startTime, now);
  return {
    enabled: true,
    ...(retention?.retainedBackups && (retention.retentionUnit ?? 'COUNT') === 'COUNT' ? { retentionDays: retention.retainedBackups } : {}),
    ...(ok ? { lastBackupAt: at(ok) } : {}),
    ...(next ? { nextBackupAt: next } : {}),
    ...(failed ? { lastFailure: { at: at(failed)!, message: (failed.error?.message ?? 'The backup run failed.').slice(0, 200) } } : {}),
  };
}
