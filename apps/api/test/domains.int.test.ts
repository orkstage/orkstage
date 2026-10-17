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

/** A tenant with one owner and one instance of the starter template (its dns resource allows custom domains). */
async function withInstance() {
  const t = await tenant(admin, 'dom');
  const owner = await api.as((await member(api.prisma, t.id, 'CustomerOwner')).email);
  const created = await admin.post('/instances', { tenantId: t.id, name: 'Domains test', slug: `dom-${unique()}`, environment: 'development', templateVersionId: ctx.starterVersionId });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return { tenantId: t.id, owner, instanceId: created.body.id as string };
}

const host = () => `api-${unique()}.example.org`;

describe('custom domains (open item 9)', () => {
  it('an owner adds a hostname and gets the records to create', async () => {
    const a = await withInstance();
    const hostname = host();
    const res = await a.owner.post(`/instances/${a.instanceId}/domains`, { hostname: hostname.toUpperCase() });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ hostname, kind: 'CUSTOM', status: 'PENDING_VERIFICATION', resourceId: 'dns', needsDeploy: false });
    expect(res.body.records[0]).toMatchObject({ purpose: 'ownership', type: 'TXT', name: `_orkstage-challenge.${hostname}` });
    expect(res.body.records[0].value).toMatch(/^orkstage-verify=/);

    const listed = await a.owner.get(`/instances/${a.instanceId}/domains`);
    expect(listed.body.map((d: { hostname: string }) => d.hostname)).toEqual([hostname]);
    expect((await a.owner.post(`/instances/${a.instanceId}/domains`, { hostname })).status).toBe(409);
    expect((await a.owner.post(`/instances/${a.instanceId}/domains`, { hostname: '*.example.org' })).status).toBe(400);

    expect((await a.owner.post(`/domains/${res.body.id}/verify`)).status).toBe(202);
    expect((await a.owner.del(`/domains/${res.body.id}`)).status).toBe(204);
    expect((await a.owner.get(`/instances/${a.instanceId}/domains`)).body).toEqual([]);
  });

  it('a hostname belongs to one instance on the platform, unless its claim failed', async () => {
    const a = await withInstance();
    const b = await withInstance();
    const hostname = host();
    const first = await a.owner.post(`/instances/${a.instanceId}/domains`, { hostname });
    const taken = await b.owner.post(`/instances/${b.instanceId}/domains`, { hostname });
    expect(taken.status).toBe(409);
    expect(taken.body.error.message).toBe('This hostname is already attached to another instance.');

    // Other tenants cannot see or touch it.
    expect((await b.owner.get(`/instances/${a.instanceId}/domains`)).status).toBe(404);
    expect((await b.owner.del(`/domains/${first.body.id}`)).status).toBe(404);

    await api.prisma.domain.update({ where: { id: first.body.id }, data: { status: 'FAILED' } });
    expect((await b.owner.post(`/instances/${b.instanceId}/domains`, { hostname })).status).toBe(201);
  });

  it('members who cannot change the instance cannot add domains; the tenant limit applies', async () => {
    const a = await withInstance();
    const viewer = await api.as((await member(api.prisma, a.tenantId, 'CustomerViewer')).email);
    expect((await viewer.get(`/instances/${a.instanceId}/domains`)).status).toBe(200);
    expect((await viewer.post(`/instances/${a.instanceId}/domains`, { hostname: host() })).status).toBe(403);

    await api.prisma.tenant.update({ where: { id: a.tenantId }, data: { limits: { maxDomainsPerInstance: 1 } } });
    expect((await a.owner.post(`/instances/${a.instanceId}/domains`, { hostname: host() })).status).toBe(201);
    const over = await a.owner.post(`/instances/${a.instanceId}/domains`, { hostname: host() });
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe('LIMIT_MAX_DOMAINS');
  });

  it('only resources the template allows serve a custom domain', async () => {
    const a = await withInstance();
    const res = await a.owner.post(`/instances/${a.instanceId}/domains`, { hostname: host(), resourceId: 'api' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('NO_DOMAIN_RESOURCE');
  });
});
