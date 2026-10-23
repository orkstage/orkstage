// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { readAzureBackups } from './backups.js';
import type { ArmReader } from './health.js';

const SERVER = '/subscriptions/0b1f6471-1bf0-4dda-aec3-111111111111/resourceGroups/ork-acme-prod-db-rg/providers/Microsoft.DBforPostgreSQL/flexibleServers/ork-acme-prod-db';

function reader(routes: Record<string, unknown>): ArmReader & { urls: string[] } {
  const urls: string[] = [];
  const fetch = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    urls.push(url.toString());
    const body = routes[url.pathname];
    return body === undefined ? new Response('not found', { status: 404 }) : Response.json(body);
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, token: async () => 'tok', urls };
}

describe('readAzureBackups', () => {
  it('reads retention and the restore point from the server and the last completed backup', async () => {
    const r = reader({
      [SERVER]: { properties: { backup: { backupRetentionDays: 14, earliestRestoreDate: '2026-10-09T10:00:00+00:00' } } },
      [`${SERVER}/backups`]: {
        value: [
          { properties: { backupType: 'FULL', completedTime: '2026-10-21T03:12:00Z' } },
          { properties: { backupType: 'FULL', completedTime: '2026-10-22T03:10:00Z' } },
          { properties: { backupType: 'FULL' } },
        ],
      },
    });
    expect(await readAzureBackups(r, { resource_id: SERVER })).toEqual({
      enabled: true,
      retentionDays: 14,
      lastBackupAt: '2026-10-22T03:10:00.000Z',
      earliestRestorableAt: '2026-10-09T10:00:00.000Z',
    });
    expect(r.urls.every((u) => u.includes('api-version=2024-08-01'))).toBe(true);
  });

  it('returns nothing for a missing server or a resource without an id', async () => {
    expect(await readAzureBackups(reader({}), { resource_id: SERVER })).toBeNull();
    expect(await readAzureBackups(reader({}), {})).toBeNull();
  });

  it('reports backups on without a last backup when the list is empty', async () => {
    const r = reader({ [SERVER]: { properties: { backup: { backupRetentionDays: 7 } } }, [`${SERVER}/backups`]: { value: [] } });
    expect(await readAzureBackups(r, { resource_id: SERVER })).toEqual({ enabled: true, retentionDays: 7 });
  });
});
