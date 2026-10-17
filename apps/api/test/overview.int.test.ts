// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { demo, member, startApi, tenant, unique, type Api, type Caller } from './harness.js';

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

describe('customer overview (open item 11)', () => {
  it('shows each instance with its components and their uptime from the health history', async () => {
    const t = await tenant(admin, 'ov');
    const viewer = await api.as((await member(api.prisma, t.id, 'CustomerViewer')).email);
    const created = await admin.post('/instances', { tenantId: t.id, name: 'Overview test', slug: `ov-${unique()}`, environment: 'development', templateVersionId: ctx.starterVersionId });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const instanceId = created.body.id as string;

    await api.prisma.statusComponent.createMany({
      data: [
        { tenantId: t.id, instanceId, name: 'API', resourceIds: ['api'], status: 'OPERATIONAL', position: 0 },
        { tenantId: t.id, instanceId, name: 'Database', resourceIds: ['database'], status: 'MAJOR_OUTAGE', position: 2 },
      ],
    });
    const now = Date.now();
    const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000);
    await api.prisma.healthCheckResult.createMany({
      data: [
        ...[1, 2, 3, 4].map((m) => ({ tenantId: t.id, instanceId, resourceId: 'api', state: 'HEALTHY' as const, checkedAt: at(m) })),
        { tenantId: t.id, instanceId, resourceId: 'database', state: 'HEALTHY' as const, checkedAt: at(3) },
        { tenantId: t.id, instanceId, resourceId: 'database', state: 'UNHEALTHY' as const, checkedAt: at(2) },
        { tenantId: t.id, instanceId, resourceId: 'database', state: 'UNKNOWN' as const, checkedAt: at(1) },
      ],
    });

    const res = await viewer.get(`/tenants/${t.id}/overview`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.totals).toMatchObject({ instances: 1, healthy: 0, openIncidents: 0 });
    const inst = res.body.instances[0];
    expect(inst).toMatchObject({ id: instanceId, simulated: expect.any(Boolean), lastDeployment: null, uptime30d: 83.33 });
    expect(inst.components.map((c: { name: string; uptime30d: number }) => [c.name, c.uptime30d])).toEqual([
      ['API', 100],
      ['Database', 50],
    ]);
    expect(inst.components[0].days).toHaveLength(30);
    expect(inst.components[0].days.filter((d: { uptime: number | null }) => d.uptime !== null).every((d: { uptime: number }) => d.uptime === 100)).toBe(true);
  });

  it('another tenant cannot read it', async () => {
    const t = await tenant(admin, 'ov');
    const outsider = await api.as((await member(api.prisma, ctx.acme.id, 'CustomerViewer')).email);
    expect((await outsider.get(`/tenants/${t.id}/overview`)).status).toBe(403);
    expect((await outsider.get(`/tenants/${ctx.acme.id}/overview`)).status).toBe(200);
  });
});
