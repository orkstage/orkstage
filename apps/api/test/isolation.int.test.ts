// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { demo, items, member, startApi, tenant, unique, type Api, type Caller } from './harness.js';

/**
 * Tenant isolation (open item 1, launch item L6): a customer of one tenant sees nothing of another
 * tenant, through lists filtered by tenant and through records fetched by id, which answer 404 so
 * the response does not tell that they exist.
 */
describe('tenant isolation', () => {
  let api: Api;
  let ctx: Awaited<ReturnType<typeof demo>>;
  let admin: Caller;
  let acmeOwner: Caller;
  let otherOwner: Caller;
  // Another tenant, made for this run: the demo Globex has an instance limit.
  let other: { id: string };
  const otherRecords: Record<string, string> = {};

  beforeAll(async () => {
    api = await startApi();
    ctx = await demo(api.prisma);
    admin = await api.as(ctx.admin);
    acmeOwner = await api.as(ctx.acmeOwner);
    other = await tenant(admin, 'iso');
    otherOwner = await api.as((await member(api.prisma, other.id, 'CustomerOwner')).email);

    // Records of the other tenant, created by platform staff.
    const slug = `iso-${unique()}`;
    const instance = await admin.post('/instances', {
      tenantId: other.id,
      name: 'Isolation test',
      slug,
      environment: 'development',
      templateVersionId: ctx.starterVersionId,
    });
    expect(instance.status, JSON.stringify(instance.body)).toBe(201);
    otherRecords.instance = instance.body.id;
    otherRecords.slug = slug;
    const deployment = await admin.post(`/instances/${instance.body.id}/deploy`);
    expect(deployment.status, JSON.stringify(deployment.body)).toBe(202);
    otherRecords.deployment = deployment.body.id;
    const incident = await admin.post('/incidents', { tenantId: other.id, instanceId: instance.body.id, title: 'Isolation test incident', message: 'Created by the integration suite.' });
    expect(incident.status, JSON.stringify(incident.body)).toBe(201);
    otherRecords.incident = incident.body.id;
    const webhook = await admin.post('/webhooks', { tenantId: other.id, url: 'https://example.com/orkstage-hook', events: ['deployment.started'] });
    expect(webhook.status, JSON.stringify(webhook.body)).toBe(201);
    otherRecords.webhook = webhook.body.webhook.id;
    const target = await api.prisma.cloudTarget.findFirstOrThrow({ where: { provider: 'mock', tenantId: null } });
    const profile = await admin.post('/profiles', { tenantId: other.id, name: `Other ${slug}`, environment: 'any', targets: [{ targetId: target.id }] });
    expect(profile.status, JSON.stringify(profile.body)).toBe(201);
    otherRecords.profile = profile.body.id;
  });

  afterAll(async () => {
    await api?.close();
  });

  it.each([
    ['instances', '/instances'],
    ['deployments', '/deployments'],
    ['incidents', '/incidents'],
    ['webhooks', '/webhooks'],
    ['audit', '/audit'],
  ])('a customer filtering %s by another tenant gets nothing', async (_name, path) => {
    const res = await acmeOwner.get(`${path}?tenantId=${other.id}`);
    // Either an empty page or a refusal; never the other tenant's rows.
    if (res.status === 200) expect(items(res.body)).toEqual([]);
    else expect([403, 404]).toContain(res.status);
  });

  it('the unfiltered lists of a customer hold only its own tenant', async () => {
    for (const path of ['/instances', '/deployments', '/incidents']) {
      const res = await acmeOwner.get(path);
      expect(res.status, path).toBe(200);
      expect(items(res.body).every((r: { tenantId: string }) => r.tenantId === ctx.acme.id), path).toBe(true);
    }
  });

  it.each([
    ['instance', (r: Record<string, string>) => `/instances/${r.instance}`],
    ['deployment', (r: Record<string, string>) => `/deployments/${r.deployment}`],
    ['deployment events', (r: Record<string, string>) => `/deployments/${r.deployment}/events`],
    ['incident', (r: Record<string, string>) => `/incidents/${r.incident}`],
    ['profile', (r: Record<string, string>) => `/profiles/${r.profile}`],
  ])("another tenant's %s answers 404", async (_name, path) => {
    const res = await acmeOwner.get(path(otherRecords));
    expect(res.status).toBe(404);
    // The owner of the other tenant does see it.
    expect((await otherOwner.get(path(otherRecords))).status).toBe(200);
  });

  it("actions on another tenant's records are refused without revealing them", async () => {
    for (const [method, path] of [
      ['POST', `/instances/${otherRecords.instance}/deploy`],
      ['POST', `/instances/${otherRecords.instance}/destroy`],
      ['PATCH', `/instances/${otherRecords.instance}`],
      ['POST', `/deployments/${otherRecords.deployment}/cancel`],
      ['POST', `/incidents/${otherRecords.incident}/updates`],
      ['DELETE', `/webhooks/${otherRecords.webhook}`],
    ] as const) {
      // Valid bodies, so the request reaches the authorization check.
      const body = method === 'PATCH' ? { name: 'Taken over' } : { status: 'RESOLVED', message: 'no', confirm: otherRecords.slug };
      const res = await acmeOwner.request(method, path, body);
      expect([403, 404], `${method} ${path}: ${res.status}`).toContain(res.status);
    }
    const still = await api.prisma.instance.findUniqueOrThrow({ where: { id: otherRecords.instance } });
    expect(still.name).toBe('Isolation test');
  });

  it("another tenant's team, status page and profiles stay hidden", async () => {
    expect([403, 404]).toContain((await acmeOwner.get(`/tenants/${other.id}/members`)).status);
    expect([403, 404]).toContain((await acmeOwner.get(`/status/${other.id}`)).status);
    expect([403, 404]).toContain((await acmeOwner.get(`/tenants/${other.id}`)).status);
    const profiles = await acmeOwner.get(`/profiles?tenantId=${other.id}`);
    expect(items(profiles.body).map((p: { id: string }) => p.id)).not.toContain(otherRecords.profile);
    const own = await acmeOwner.get('/profiles');
    expect(items(own.body).every((p: { tenantId: string | null }) => p.tenantId === null || p.tenantId === ctx.acme.id)).toBe(true);
  });

  it('a customer cannot create records in another tenant', async () => {
    const instance = await acmeOwner.post('/instances', {
      tenantId: other.id,
      name: 'Intruder',
      slug: `intruder-${unique()}`,
      environment: 'development',
      templateVersionId: ctx.starterVersionId,
    });
    expect([403, 404]).toContain(instance.status);
    const webhook = await acmeOwner.post('/webhooks', { tenantId: other.id, url: 'https://example.com/intruder', events: ['deployment.started'] });
    expect([403, 404]).toContain(webhook.status);
  });
});
