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

const put = (c: Caller, path: string, body: unknown) => c.request('PUT', path, body);

describe('policies as data (open item 12)', () => {
  it('platform staff set the platform policy; tenants cannot', async () => {
    const before = (await admin.get('/policies')).body;
    try {
      expect((await put(admin, '/policies', { disabled: ['no-such-policy'] })).status).toBe(422);
      expect((await put(admin, '/policies', { maxReplicas: 0 })).status).toBe(400);
      const saved = await put(admin, '/policies', { ...before, maxMonthlyCostUsd: 9_000_000 });
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      expect((await admin.get('/policies')).body.maxMonthlyCostUsd).toBe(9_000_000);
      const owner = await api.as(ctx.acmeOwner);
      expect((await owner.get('/policies')).status).toBe(403);
      expect((await put(owner, '/policies', { maxReplicas: 1 })).status).toBe(403);
    } finally {
      await put(admin, '/policies', before);
    }
  });

  it('a tenant tightens its own policy, and instances are checked against the result', async () => {
    const t = await tenant(admin, 'pol');
    const owner = await api.as((await member(api.prisma, t.id, 'CustomerOwner')).email);
    const viewer = await api.as((await member(api.prisma, t.id, 'CustomerViewer')).email);

    expect((await put(owner, `/tenants/${t.id}/policy`, { disabled: ['required-labels'] })).status).toBe(400);
    expect((await put(viewer, `/tenants/${t.id}/policy`, { requiredLabels: ['cost-center'] })).status).toBe(403);
    const saved = await put(owner, `/tenants/${t.id}/policy`, { requiredLabels: ['cost-center'], minTlsVersion: '1.3' });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.effective).toMatchObject({ requiredLabels: ['cost-center'], minTlsVersion: '1.3' });
    expect(saved.body.builtIn).toContain('required-labels');
    expect((await viewer.get(`/tenants/${t.id}/policy`)).body.tenant).toEqual({ requiredLabels: ['cost-center'], minTlsVersion: '1.3' });

    const unlabelled = await admin.post('/instances', { tenantId: t.id, name: 'No labels', slug: `pol-${unique()}`, environment: 'development', templateVersionId: ctx.starterVersionId });
    expect(unlabelled.status, JSON.stringify(unlabelled.body)).toBe(201);
    const preview = await owner.post(`/instances/${unlabelled.body.id}/preview`);
    expect(JSON.stringify(preview.body)).toContain('POLICY_REQUIRED_LABELS');

    const fixed = await owner.patch(`/instances/${unlabelled.body.id}`, { labels: { 'cost-center': 'cc-42' } });
    expect(fixed.status, JSON.stringify(fixed.body)).toBe(200);
    expect(fixed.body.labels).toEqual({ 'cost-center': 'cc-42' });
    expect(JSON.stringify((await owner.post(`/instances/${unlabelled.body.id}/preview`)).body)).not.toContain('POLICY_REQUIRED_LABELS');

    expect((await owner.patch(`/instances/${unlabelled.body.id}`, { labels: { 'platform:managed': 'false' } })).status).toBe(400);
  });

  it('another tenant cannot read or change it', async () => {
    const t = await tenant(admin, 'pol');
    const outsider = await api.as(ctx.acmeOwner);
    expect((await outsider.get(`/tenants/${t.id}/policy`)).status).toBe(403);
    expect((await put(outsider, `/tenants/${t.id}/policy`, { maxReplicas: 1 })).status).toBe(403);
  });
});
