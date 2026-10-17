// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { demo, items, member, startApi, tenant, unique, user, type Api, type Caller } from './harness.js';

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

/** A tenant of its own, with one owner, so team rules can be checked without touching the demo. */
async function freshTenant() {
  const t = await tenant(admin);
  return { id: t.id, owner: await member(api.prisma, t.id, 'CustomerOwner') };
}

describe('API keys', () => {
  it('act within their scopes and their tenant', async () => {
    const owner = await api.as(ctx.acmeOwner);
    const created = await owner.post('/api-keys', { name: `read only ${unique()}`, tenantId: ctx.acme.id, role: 'CustomerAdmin', scopes: ['instances:read'] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const key = api.withKey(created.body.token);

    const list = await key.get('/instances');
    expect(list.status).toBe(200);
    expect(items(list.body).every((i: { tenantId: string }) => i.tenantId === ctx.acme.id)).toBe(true);
    expect(items((await key.get(`/instances?tenantId=${ctx.globex.id}`)).body)).toEqual([]);

    const instance = items(list.body)[0] as { id: string } | undefined;
    if (instance) {
      const deploy = await key.post(`/instances/${instance.id}/deploy`);
      expect(deploy.status).toBe(403);
      expect(deploy.body.error.code).toBe('API_KEY_SCOPE');
    }
    // Routes without a scope are for people only.
    const invite = await key.post(`/tenants/${ctx.acme.id}/invitations`, { email: `x-${unique()}@example.local`, role: 'CustomerViewer' });
    expect(invite.status).toBe(403);
    expect(invite.body.error.code).toBe('API_KEY_NOT_ALLOWED');
  });

  it('stop working when revoked, and when their creator leaves the tenant', async () => {
    const owner = await api.as(ctx.acmeOwner);
    const revoked = await owner.post('/api-keys', { name: `revoked ${unique()}`, tenantId: ctx.acme.id, role: 'CustomerViewer', scopes: ['instances:read'] });
    expect((await api.withKey(revoked.body.token).get('/instances')).status).toBe(200);
    expect((await owner.del(`/api-keys/${revoked.body.apiKey.id}`)).status).toBeLessThan(300);
    expect((await api.withKey(revoked.body.token).get('/instances')).status).toBe(401);

    const leaver = await member(api.prisma, ctx.acme.id, 'CustomerAdmin');
    const leaverSession = await api.as(leaver.email);
    const theirs = await leaverSession.post('/api-keys', { name: `leaver ${unique()}`, tenantId: ctx.acme.id, role: 'CustomerViewer', scopes: ['instances:read'] });
    expect(theirs.status, JSON.stringify(theirs.body)).toBe(201);
    expect((await api.withKey(theirs.body.token).get('/instances')).status).toBe(200);
    expect((await owner.del(`/tenants/${ctx.acme.id}/members/${leaver.userId}`)).status).toBeLessThan(300);
    expect((await api.withKey(theirs.body.token).get('/instances')).status).toBe(401);
  });
});

describe('team', () => {
  it('keeps at least one owner', async () => {
    const t = await freshTenant();
    const owner = await api.as(t.owner.email);
    const demote = await owner.patch(`/tenants/${t.id}/members/${t.owner.userId}`, { role: 'CustomerAdmin' });
    expect(demote.status).toBe(422);
    expect(demote.body.error.code).toBe('LAST_OWNER');
    const leave = await owner.del(`/tenants/${t.id}/members/${t.owner.userId}`);
    expect(leave.body.error.code).toBe('LAST_OWNER');
  });

  it('accepts an invitation once, and only from the invited address', async () => {
    const t = await freshTenant();
    const owner = await api.as(t.owner.email);
    const email = `invited-${unique()}@example.local`;
    const invite = await owner.post(`/tenants/${t.id}/invitations`, { email, role: 'CustomerViewer' });
    expect(invite.status, JSON.stringify(invite.body)).toBe(201);
    const token = String(invite.body.link).split('/invite/')[1];

    const stranger = await api.as(await user(api.prisma));
    const wrong = await stranger.post(`/invitations/${token}/accept`);
    expect(wrong.status).toBe(403);
    expect(wrong.body.error.code).toBe('INVITATION_EMAIL_MISMATCH');

    const invited = await api.as(await user(api.prisma, email));
    expect((await invited.post(`/invitations/${token}/accept`)).status).toBeLessThan(300);
    const again = await invited.post(`/invitations/${token}/accept`);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('INVITATION_USED');
    // Viewers read their tenant but cannot invite.
    expect((await invited.get(`/tenants/${t.id}/members`)).status).toBe(200);
    expect((await invited.post(`/tenants/${t.id}/invitations`, { email: `x-${unique()}@example.local`, role: 'CustomerViewer' })).status).toBe(403);
  });

  it('only platform owners and admins set tenant limits', async () => {
    const t = await freshTenant();
    const owner = await api.as(t.owner.email);
    expect((await owner.patch(`/tenants/${t.id}`, { limits: { maxInstances: 99 } })).status).toBe(403);
    const set = await admin.patch(`/tenants/${t.id}`, { limits: { maxInstances: 0 } });
    expect(set.status).toBe(200);
    expect(set.body.limits).toEqual({ maxInstances: 0 });
    const blocked = await owner.post('/instances', { tenantId: t.id, name: 'Over quota', slug: `quota-${unique()}`, environment: 'development', templateVersionId: ctx.starterVersionId });
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.code).toBe('QUOTA_EXCEEDED');
  });
});

describe('platform guards', () => {
  it('writes audit rows for creating and deploying an instance and for flag changes', async () => {
    const slug = `audit-${unique()}`;
    const instance = await admin.post('/instances', { tenantId: ctx.acme.id, name: 'Audit test', slug, environment: 'development', templateVersionId: ctx.starterVersionId });
    expect(instance.status, JSON.stringify(instance.body)).toBe(201);
    expect((await admin.post(`/instances/${instance.body.id}/deploy`)).status).toBe(202);
    expect((await admin.request('PUT', '/feature-flags/TEMPLATE_MARKETPLACE', { enabled: true, tenantId: ctx.acme.id })).status).toBeLessThan(300);

    const rows = await api.prisma.auditEvent.findMany({ where: { OR: [{ resourceId: instance.body.id }, { resourceType: 'FeatureFlag', tenantId: ctx.acme.id }] } });
    const actions = rows.map((r) => `${r.resourceType}:${r.action}`);
    expect(actions).toEqual(expect.arrayContaining(['Instance:CREATE', 'Instance:DEPLOY']));
    expect(actions.some((a) => a.startsWith('FeatureFlag:'))).toBe(true);
    // The audit table only accepts inserts.
    await expect(api.prisma.auditEvent.deleteMany({ where: { id: rows[0]!.id } })).rejects.toThrow();
  });

  it('refuses targets of a provider that is switched off', async () => {
    const res = await admin.post('/cloud/targets', {
      provider: 'azure',
      name: `Azure ${unique()}`,
      environment: 'any',
      config: { subscriptionId: '00000000-0000-0000-0000-000000000000' },
      allowedRegions: ['eastus'],
      defaultRegion: 'eastus',
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PROVIDER_DISABLED');
  });

  it('rate limits sign in per client address (Redis counters)', async () => {
    const client = api.anonymous();
    const statuses: number[] = [];
    for (let i = 0; i < 12; i += 1) statuses.push((await client.post('/auth/dev-login', { email: `rate-${unique()}@example.local` })).status);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
  });

  it('answers 401 without credentials', async () => {
    expect((await api.anonymous().get('/instances')).status).toBe(401);
    expect((await api.withKey('ork_live_00000000_notarealkeynotarealkey').get('/instances')).status).toBe(401);
  });
});

describe('cloud targets', () => {
  const aws = (name: string) => ({
    provider: 'aws',
    name,
    environment: 'development',
    config: { accountId: '123456789012', roleArn: 'arn:aws:iam::123456789012:role/orkstage-deploy' },
    credentialRef: 'env://ORKSTAGE_TEST_EXTERNAL_ID',
    allowedRegions: ['us-east-1', 'eu-west-1'],
    defaultRegion: 'us-east-1',
  });

  it('refuse a role from another account', async () => {
    const res = await admin.post('/cloud/targets', { ...aws(`AWS ${unique()}`), config: { accountId: '123456789012', roleArn: 'arn:aws:iam::210987654321:role/orkstage-deploy' } });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INVALID_CONFIG');
  });

  it('can be edited, keep their account, and are validated again after a change', async () => {
    const created = await admin.post('/cloud/targets', aws(`AWS ${unique()}`));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.id as string;
    await api.prisma.cloudTarget.update({ where: { id }, data: { lastValidation: { ok: true, checks: [], validatedAt: new Date().toISOString() }, lastValidatedAt: new Date(), health: 'HEALTHY' } });

    // Only the name: the validation stands.
    const renamed = await admin.patch(`/cloud/targets/${id}`, { name: `Renamed ${unique()}` });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    expect(renamed.body.lastValidation).not.toBeNull();

    const edited = await admin.patch(`/cloud/targets/${id}`, {
      config: { roleArn: 'arn:aws:iam::123456789012:role/orkstage-deploy-v2', dnsZone: 'apps.example.com' },
      credentialRef: 'env://ORKSTAGE_TEST_EXTERNAL_ID_2',
    });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body.config).toMatchObject({ accountId: '123456789012', roleArn: 'arn:aws:iam::123456789012:role/orkstage-deploy-v2', dnsZone: 'apps.example.com' });
    expect(edited.body.lastValidation).toBeNull();
    expect(edited.body.health).toBe('UNKNOWN');

    const cleared = await admin.patch(`/cloud/targets/${id}`, { config: { dnsZone: null } });
    expect(cleared.body.config.dnsZone).toBeUndefined();

    const account = await admin.patch(`/cloud/targets/${id}`, { config: { accountId: '210987654321' } });
    expect(account.status).toBe(422);
    expect(account.body.error.code).toBe('FIELD_FIXED');
    expect((await admin.patch(`/cloud/targets/${id}`, { environment: 'production' })).status).toBe(400);
    expect((await admin.patch(`/cloud/targets/${id}`, { config: { roleArn: 'arn:aws:iam::210987654321:role/x' } })).body.error.code).toBe('INVALID_CONFIG');

    const audit = await api.prisma.auditEvent.findMany({ where: { resourceId: id, action: 'UPDATE' } });
    expect(audit.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(audit.map((a) => a.changes))).not.toContain('ORKSTAGE_TEST_EXTERNAL_ID_2');
  });

  it('keep regions that a profile still uses', async () => {
    const created = await admin.post('/cloud/targets', aws(`AWS ${unique()}`));
    const id = created.body.id as string;
    const profile = await admin.post('/profiles', { name: `Europe ${unique()}`, environment: 'development', targets: [{ targetId: id, region: 'eu-west-1' }] });
    expect(profile.status, JSON.stringify(profile.body)).toBe(201);
    const res = await admin.patch(`/cloud/targets/${id}`, { allowedRegions: ['us-east-1'] });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('REGION_IN_USE');
  });

  it('are edited by platform staff only', async () => {
    const created = await admin.post('/cloud/targets', aws(`AWS ${unique()}`));
    const owner = await api.as(ctx.acmeOwner);
    expect((await owner.patch(`/cloud/targets/${created.body.id}`, { name: `Mine ${unique()}` })).status).toBe(403);
  });
});
