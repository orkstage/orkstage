// SPDX-License-Identifier: AGPL-3.0-only
import { sha256 } from '@orkstage/domain';
import { unsubscribeToken } from '@orkstage/runtime';
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

async function freshTenant() {
  const t = await tenant(admin, 'st');
  const owner = await member(api.prisma, t.id, 'CustomerOwner');
  const viewer = await member(api.prisma, t.id, 'CustomerViewer');
  return { ...t, owner: await api.as(owner.email), viewer: await api.as(viewer.email), viewerEmail: viewer.email };
}

const put = (c: Caller, path: string, body?: unknown) => c.request('PUT', path, body);

describe('status page visibility (open item 8)', () => {
  it('members read it by default; a private page is for owners, admins and staff', async () => {
    const t = await freshTenant();
    expect((await t.viewer.get(`/status/${t.id}`)).body.page).toMatchObject({ visibility: 'CUSTOMER_ONLY', slug: null });
    expect((await put(t.viewer, `/status-pages/${t.id}`, { visibility: 'PRIVATE' })).status).toBe(403);

    expect((await put(t.owner, `/status-pages/${t.id}`, { visibility: 'PRIVATE' })).status).toBe(200);
    expect((await t.viewer.get(`/status/${t.id}`)).status).toBe(404);
    expect((await t.owner.get(`/status/${t.id}`)).status).toBe(200);
    expect((await admin.get(`/status/${t.id}`)).status).toBe(200);
  });

  it('a public page shows names and states to anyone, and only while it is public', async () => {
    const t = await freshTenant();
    const slug = `st-${unique()}`;
    expect((await put(t.owner, `/status-pages/${t.id}`, { visibility: 'PUBLIC' })).status).toBe(400);
    expect((await put(t.owner, `/status-pages/${t.id}`, { visibility: 'PUBLIC', slug: 'unsubscribe' })).status).toBe(400);
    const saved = await put(t.owner, `/status-pages/${t.id}`, { visibility: 'PUBLIC', slug, title: 'Example status' });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);

    const anyone = api.anonymous();
    const page = await anyone.get(`/public/status/${slug}`);
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({ title: 'Example status', overall: 'OPERATIONAL', openIncidents: [] });
    expect(JSON.stringify(page.body)).not.toContain(t.id);

    // Another tenant cannot take the address; an unknown or private page looks missing.
    const other = await freshTenant();
    expect((await put(other.owner, `/status-pages/${other.id}`, { visibility: 'PUBLIC', slug })).status).toBe(409);
    expect((await anyone.get(`/public/status/${other.slug}`)).status).toBe(404);
    await put(t.owner, `/status-pages/${t.id}`, { visibility: 'CUSTOMER_ONLY', slug });
    expect((await anyone.get(`/public/status/${slug}`)).status).toBe(404);
  });

  it('automated incidents read as a plain impact on the public page', async () => {
    const t = await freshTenant();
    const slug = `st-${unique()}`;
    await put(t.owner, `/status-pages/${t.id}`, { visibility: 'PUBLIC', slug });
    await api.prisma.incident.create({
      data: { tenantId: t.id, title: 'web cpu > 90 on secret-instance', impact: 'DEGRADED', source: 'AUTOMATED', updates: { create: { status: 'INVESTIGATING', message: 'Automated: cpu avg is 99 (rule)' } } },
    });
    const page = await api.anonymous().get(`/public/status/${slug}`);
    expect(page.body.openIncidents).toHaveLength(1);
    expect(page.body.openIncidents[0]).toMatchObject({ title: 'Degraded performance', updates: [{ message: 'We detected a problem and are looking into it.' }] });
    expect(JSON.stringify(page.body)).not.toMatch(/cpu|secret-instance|Automated/);
  });
});

describe('status page components', () => {
  it('owners rename, hide and order components of their own tenant only', async () => {
    const instance = await api.prisma.instance.findFirstOrThrow({ where: { tenantId: ctx.acme.id } });
    const component = await api.prisma.statusComponent.create({ data: { tenantId: ctx.acme.id, instanceId: instance.id, name: `IT ${unique()}`, status: 'OPERATIONAL' } });
    try {
      const owner = await api.as(ctx.acmeOwner);
      const res = await owner.patch(`/status-pages/${ctx.acme.id}/components/${component.id}`, { label: 'Checkout', sortOrder: 0 });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const status = await owner.get(`/status/${ctx.acme.id}`);
      const shown = status.body.instances.find((i: { id: string }) => i.id === instance.id);
      expect(shown.components[0]).toMatchObject({ id: component.id, name: 'Checkout' });

      await owner.patch(`/status-pages/${ctx.acme.id}/components/${component.id}`, { hidden: true });
      const hidden = (await owner.get(`/status/${ctx.acme.id}`)).body.instances.find((i: { id: string }) => i.id === instance.id);
      expect(hidden.components.some((c: { id: string }) => c.id === component.id)).toBe(false);

      // Through another tenant's path, the component does not exist.
      const other = await freshTenant();
      expect((await other.owner.patch(`/status-pages/${other.id}/components/${component.id}`, { hidden: false })).status).toBe(404);
      expect((await other.owner.patch(`/status-pages/${ctx.acme.id}/components/${component.id}`, { hidden: false })).status).toBe(403);
    } finally {
      await api.prisma.statusComponent.delete({ where: { id: component.id } });
    }
  });
});

describe('status subscriptions', () => {
  it('a member subscribes their own address at once', async () => {
    const t = await freshTenant();
    expect((await put(t.viewer, `/status-pages/${t.id}/subscription`)).status).toBe(204);
    expect((await t.viewer.get(`/status/${t.id}`)).body.subscribed).toBe(true);
    expect((await t.owner.get(`/status-pages/${t.id}/settings`)).body.confirmedSubscribers).toBe(1);
    expect((await t.viewer.del(`/status-pages/${t.id}/subscription`)).status).toBe(204);
    expect((await t.viewer.get(`/status/${t.id}`)).body.subscribed).toBe(false);
  });

  it('the public subscribes with a confirmation link and leaves with the unsubscribe link', async () => {
    const t = await freshTenant();
    const slug = `st-${unique()}`;
    await put(t.owner, `/status-pages/${t.id}`, { visibility: 'PUBLIC', slug });
    const anyone = api.anonymous();
    const email = `reader-${unique()}@example.test`;
    expect((await anyone.post(`/public/status/${slug}/subscriptions`, { email })).status).toBe(202);
    expect((await anyone.post(`/public/status/${slug}/subscriptions`, { email })).status).toBe(202);

    const sub = await api.prisma.statusSubscription.findFirstOrThrow({ where: { email } });
    expect(sub.confirmedAt).toBeNull();
    // The token only travels by email: put a known one in its place.
    await api.prisma.statusSubscription.update({ where: { id: sub.id }, data: { tokenHash: sha256('known-token') } });
    expect((await anyone.post('/public/status/subscriptions/wrong-token/confirm')).status).toBe(404);
    expect((await anyone.post('/public/status/subscriptions/known-token/confirm')).status).toBe(204);
    expect((await api.prisma.statusSubscription.findUniqueOrThrow({ where: { id: sub.id } })).confirmedAt).not.toBeNull();

    expect((await anyone.del(`/public/status/subscriptions/${sub.id}.forged`)).status).toBe(204);
    expect(await api.prisma.statusSubscription.count({ where: { id: sub.id } })).toBe(1);
    expect((await anyone.del(`/public/status/subscriptions/${unsubscribeToken(process.env.SESSION_SECRET!, sub.id)}`)).status).toBe(204);
    expect(await api.prisma.statusSubscription.count({ where: { id: sub.id } })).toBe(0);
  });

  it('nobody subscribes to a page that is not public without signing in', async () => {
    const t = await freshTenant();
    expect((await api.anonymous().post(`/public/status/${t.slug}/subscriptions`, { email: 'x@example.test' })).status).toBe(404);
  });
});

describe('maintenance windows', () => {
  const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

  it('owners schedule and end them; members read them; other tenants cannot touch them', async () => {
    const t = await freshTenant();
    const body = { tenantId: t.id, title: 'Database upgrade', message: 'Short writes pause.', componentNames: ['Database'], startsAt: inMinutes(-1), endsAt: inMinutes(60) };
    expect((await t.viewer.post('/maintenance-windows', body)).status).toBe(403);
    expect((await t.owner.post('/maintenance-windows', { ...body, endsAt: inMinutes(-2) })).status).toBe(400);
    const created = await t.owner.post('/maintenance-windows', body);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ state: 'in_progress', componentNames: ['Database'] });

    expect((await t.viewer.get(`/maintenance-windows?tenantId=${t.id}`)).body).toHaveLength(1);
    expect((await t.viewer.get(`/status/${t.id}`)).body.maintenance[0]).toMatchObject({ title: 'Database upgrade', state: 'in_progress' });

    const other = await freshTenant();
    expect((await other.owner.get(`/maintenance-windows?tenantId=${t.id}`)).status).toBe(403);
    expect((await other.owner.del(`/maintenance-windows/${created.body.id}`)).status).toBe(404);

    const later = await t.owner.post('/maintenance-windows', { ...body, startsAt: inMinutes(60), endsAt: inMinutes(120) });
    expect(later.body.state).toBe('scheduled');
    expect((await t.owner.patch(`/maintenance-windows/${later.body.id}`, { endsAt: inMinutes(30) })).status).toBe(422);

    // Ending the running window keeps it in the history; cancelling a future one deletes it.
    expect((await t.owner.del(`/maintenance-windows/${created.body.id}`)).status).toBe(204);
    expect((await t.owner.del(`/maintenance-windows/${later.body.id}`)).status).toBe(204);
    expect((await t.owner.get(`/maintenance-windows?tenantId=${t.id}`)).body).toEqual([]);
    expect((await t.owner.get(`/maintenance-windows?tenantId=${t.id}&include=past`)).body).toHaveLength(1);
  });
});
