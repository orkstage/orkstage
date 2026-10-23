// SPDX-License-Identifier: AGPL-3.0-only
import type { BackupInfo, ResourceOutputs } from '@orkstage/cloud-core';
import { azureJson } from './auth.js';
import { armUrl, mainResourceId, type ArmReader } from './health.js';

interface FlexibleServer {
  properties?: { backup?: { backupRetentionDays?: number; earliestRestoreDate?: string } };
}

interface ServerBackup {
  properties?: { backupType?: string; completedTime?: string };
}

const iso = (t: string | undefined) => (t && !Number.isNaN(Date.parse(t)) ? new Date(t).toISOString() : undefined);

/**
 * Backups of an Azure Database for PostgreSQL flexible server (open item 18): the retention and the
 * earliest restore point from the server, the last completed backup from its backup list. Flexible
 * servers always keep backups; Azure does not report a schedule or failed backups through these
 * APIs, so neither is returned (the worker flags a backup overdue after 26 hours on its own).
 */
export async function readAzureBackups(r: ArmReader, outputs: ResourceOutputs): Promise<BackupInfo | null> {
  const id = mainResourceId(outputs);
  if (!id) return null;
  const token = await r.token();
  const server = await azureJson<FlexibleServer>(r.fetch, armUrl(id), token, { signal: r.signal, allow404: true });
  if (!server) return null;
  const list = await azureJson<{ value?: ServerBackup[] }>(r.fetch, armUrl(id, '/backups'), token, { signal: r.signal, allow404: true });
  const last = (list?.value ?? [])
    .map((b) => iso(b.properties?.completedTime))
    .filter((t): t is string => t !== undefined)
    .sort()
    .at(-1);
  const backup = server.properties?.backup ?? {};
  const earliest = iso(backup.earliestRestoreDate);
  return {
    enabled: true,
    ...(backup.backupRetentionDays ? { retentionDays: backup.backupRetentionDays } : {}),
    ...(last ? { lastBackupAt: last } : {}),
    ...(earliest ? { earliestRestorableAt: earliest } : {}),
  };
}
