// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import type { GcpApi } from './auth.js';
import { nextDailyWindow, readGcpBackups } from './backups.js';

const BASE = 'https://sqladmin.googleapis.com/v1/projects/acme-prod-123/instances/ork-acme-prod-db';
const NOW = new Date('2026-10-23T12:00:00Z');

const api =
  (routes: Record<string, unknown>): GcpApi =>
  async <T>(url: string) =>
    (routes[url] ?? null) as T | null;

const instance = (backupConfiguration: unknown) => ({ settings: { backupConfiguration } });

describe('readGcpBackups', () => {
  it('reads the configuration, the last successful run and the next window', async () => {
    const info = await readGcpBackups(
      api({
        [BASE]: instance({ enabled: true, startTime: '03:00', backupRetentionSettings: { retainedBackups: 7, retentionUnit: 'COUNT' } }),
        [`${BASE}/backupRuns?maxResults=20`]: {
          items: [
            { status: 'SUCCESSFUL', type: 'AUTOMATED', endTime: '2026-10-22T03:20:00Z' },
            { status: 'SUCCESSFUL', type: 'AUTOMATED', endTime: '2026-10-23T03:18:00Z' },
          ],
        },
      }),
      { instance_name: 'ork-acme-prod-db' },
      'acme-prod-123',
      NOW,
    );
    expect(info).toEqual({ enabled: true, retentionDays: 7, lastBackupAt: '2026-10-23T03:18:00.000Z', nextBackupAt: '2026-10-24T03:00:00.000Z' });
  });

  it('reports the latest failed run with its message', async () => {
    const info = await readGcpBackups(
      api({
        [BASE]: instance({ enabled: true, startTime: '03:00' }),
        [`${BASE}/backupRuns?maxResults=20`]: {
          items: [
            { status: 'SUCCESSFUL', endTime: '2026-10-22T03:20:00Z' },
            { status: 'FAILED', enqueuedTime: '2026-10-23T03:00:00Z', error: { message: 'Quota exceeded' } },
          ],
        },
      }),
      { instance_name: 'ork-acme-prod-db' },
      'acme-prod-123',
      NOW,
    );
    expect(info?.lastBackupAt).toBe('2026-10-22T03:20:00.000Z');
    expect(info?.lastFailure).toEqual({ at: '2026-10-23T03:00:00.000Z', message: 'Quota exceeded' });
  });

  it('says when backups are off, and returns nothing without an instance', async () => {
    expect(await readGcpBackups(api({ [BASE]: instance({ enabled: false }) }), { instance_name: 'ork-acme-prod-db' }, 'acme-prod-123', NOW)).toEqual({ enabled: false });
    expect(await readGcpBackups(api({}), { instance_name: 'ork-acme-prod-db' }, 'acme-prod-123', NOW)).toBeNull();
    expect(await readGcpBackups(api({}), {}, 'acme-prod-123', NOW)).toBeNull();
  });
});

describe('nextDailyWindow', () => {
  it('returns today when the window is still ahead, tomorrow otherwise', () => {
    expect(nextDailyWindow('18:30', NOW)).toBe('2026-10-23T18:30:00.000Z');
    expect(nextDailyWindow('03:00', NOW)).toBe('2026-10-24T03:00:00.000Z');
    expect(nextDailyWindow(undefined, NOW)).toBeUndefined();
  });
});
