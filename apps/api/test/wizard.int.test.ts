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

describe('instance preview before creation (open item 14)', () => {
  it('returns the resolved plan, policies and cost without creating anything', async () => {
    const t = await tenant(admin, 'wiz');
    const owner = await api.as((await member(api.prisma, t.id, 'CustomerOwner')).email);
    const body = { tenantId: t.id, name: 'Wizard preview', slug: `wiz-${unique()}`, environment: 'development', templateVersionId: ctx.starterVersionId };

    const res = await owner.post('/instances/preview', body);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.resources.length).toBeGreaterThan(3);
    expect(res.body.cost.total).toBeGreaterThan(0);
    expect(res.body.policyResults.length).toBeGreaterThan(0);
    expect(Object.keys(res.body.bindings)).toContain('primary');
    expect(await api.prisma.instance.count({ where: { tenantId: t.id } })).toBe(0);

    const viewer = await api.as((await member(api.prisma, t.id, 'CustomerViewer')).email);
    expect((await viewer.post('/instances/preview', body)).status).toBe(403);
    const outsider = await api.as(ctx.acmeOwner);
    expect((await outsider.post('/instances/preview', body)).status).toBe(403);
  });
});
