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

describe('Idempotency-Key (open item 21)', () => {
  it('replays the first response for a retry and refuses a key reused for another request', async () => {
    const t = await tenant(admin, 'idem');
    const owner = await api.as((await member(api.prisma, t.id, 'CustomerOwner')).email);
    const body = { tenantId: t.id, name: 'Retried create', slug: `idem-${unique()}`, environment: 'development', templateVersionId: ctx.starterVersionId };
    const key = { 'idempotency-key': `create-${unique()}` };

    const first = await owner.request('POST', '/instances', body, key);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const retry = await owner.request('POST', '/instances', body, key);
    expect(retry.status).toBe(201);
    expect(retry.body.id).toBe(first.body.id);
    expect(await api.prisma.instance.count({ where: { tenantId: t.id } })).toBe(1);

    const other = await owner.request('POST', '/instances', { ...body, name: 'Something else' }, key);
    expect(other.status).toBe(422);
    expect(other.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('scopes keys to the caller and rejects malformed ones', async () => {
    const t = await tenant(admin, 'idem');
    const owner = await api.as((await member(api.prisma, t.id, 'CustomerOwner')).email);
    const other = await api.as((await member(api.prisma, t.id, 'CustomerOwner')).email);
    const key = { 'idempotency-key': `shared-${unique()}` };
    const body = (name: string) => ({ tenantId: t.id, name, slug: `idem-${unique()}`, environment: 'development', templateVersionId: ctx.starterVersionId });

    expect((await owner.request('POST', '/instances', body('First owner'), key)).status).toBe(201);
    expect((await other.request('POST', '/instances', body('Second owner'), key)).status).toBe(201);
    expect(await api.prisma.instance.count({ where: { tenantId: t.id } })).toBe(2);

    const bad = await owner.request('POST', '/instances', body('Bad key'), { 'idempotency-key': 'short' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('IDEMPOTENCY_KEY_INVALID');
  });

  it('keeps nothing for a failed request, so a retry runs it again', async () => {
    const t = await tenant(admin, 'idem');
    const owner = await api.as((await member(api.prisma, t.id, 'CustomerOwner')).email);
    const key = { 'idempotency-key': `failed-${unique()}` };
    const invalid = { tenantId: t.id, name: 'x', slug: `idem-${unique()}`, environment: 'development', templateVersionId: ctx.starterVersionId };
    expect((await owner.request('POST', '/instances', invalid, key)).status).toBe(400);
    expect((await owner.request('POST', '/instances', invalid, key)).status).toBe(400);
  });
});
