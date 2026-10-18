// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { demo, startApi, tenant, unique, type Api, type Caller } from './harness.js';

let api: Api;
let ctx: Awaited<ReturnType<typeof demo>>;
let admin: Caller;

beforeAll(async () => {
  api = await startApi();
  ctx = await demo(api.prisma);
  admin = await api.as(ctx.admin);
});

afterAll(async () => {
  await api?.close();
});

describe('backups before a production destroy (open item 18)', () => {
  it('refuses while a database has no backup from the last day, unless confirmed', async () => {
    const t = await tenant(admin, 'bak');
    const slug = `bak-${unique()}`;
    const created = await admin.post('/instances', { tenantId: t.id, name: 'Backups', slug, environment: 'production', templateVersionId: ctx.starterVersionId });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const instanceId = created.body.id as string;
    const target = await api.prisma.cloudTarget.findFirstOrThrow({ where: { provider: 'mock' } });
    const db = await api.prisma.instanceResource.create({
      data: {
        tenantId: t.id,
        instanceId,
        resourceId: 'database',
        type: 'database.postgresql',
        slot: 'primary',
        provider: 'mock',
        targetId: target.id,
        region: target.defaultRegion,
        capability: 'rds-postgres',
        capabilityName: 'Simulated RDS',
        name: `ork-${slug}-db`,
        status: 'ACTIVE',
      },
    });

    const refused = await admin.post(`/instances/${instanceId}/destroy`, { confirm: slug });
    expect(refused.status).toBe(422);
    expect(refused.body.error).toMatchObject({ code: 'BACKUP_NOT_RECENT', details: { resources: ['database'] } });

    await api.prisma.instanceResource.update({ where: { id: db.id }, data: { backupState: { checkedAt: new Date().toISOString(), enabled: true, lastBackupAt: new Date(Date.now() - 3_600_000).toISOString(), problem: null } } });
    const instance = await admin.get(`/instances/${instanceId}`);
    expect(instance.body.resources.find((r: { resourceId: string }) => r.resourceId === 'database').backup).toMatchObject({ enabled: true, problem: null });
    expect((await admin.post(`/instances/${instanceId}/destroy`, { confirm: slug })).status).not.toBe(422);
  });
});
