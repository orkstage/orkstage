// SPDX-License-Identifier: AGPL-3.0-only
// Sign in account linking (acceptance item 96.1) and the session list of open item 10.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { githubIdentity, IdentityLinker } from '../dist/auth/identity-linker.js';
import { demo, startApi, unique, user, type Api, type Caller } from './harness.js';

/** A user record (the harness helper returns only the email). */
async function newUser() {
  const email = await user(api.prisma);
  return api.prisma.user.findUniqueOrThrow({ where: { email } });
}

let api: Api;
let ctx: Awaited<ReturnType<typeof demo>>;
let admin: Caller;
let linker: IdentityLinker;
let providerId: string;

beforeAll(async () => {
  api = await startApi();
  ctx = await demo(api.prisma);
  admin = await api.as(ctx.admin);
  linker = api.app.get(IdentityLinker);
  const key = `it-${unique()}`;
  providerId = (
    await api.prisma.identityProvider.create({
      data: { key, kind: 'oidc', name: key, issuer: `https://${key}.example`, clientId: 'c', clientSecretRef: 'env://OIDC_IT_CLIENT_SECRET' },
    })
  ).id;
});

afterAll(async () => {
  await api?.close();
});

describe('account linking', () => {
  it('links a verified email to the existing account, then finds it by subject', async () => {
    const u = await newUser();
    const subject = `sub-${unique()}`;
    const first = await linker.resolve(providerId, { subject, email: u.email.toUpperCase(), emailVerified: true });
    expect(first?.id).toBe(u.id);
    // The email changes at the provider: the link by subject still wins.
    const again = await linker.resolve(providerId, { subject, email: `other-${unique()}@example.local`, emailVerified: false });
    expect(again?.id).toBe(u.id);
  });

  it('never links an unverified email', async () => {
    const u = await newUser();
    expect(await linker.resolve(providerId, { subject: `sub-${unique()}`, email: u.email, emailVerified: false })).toBeNull();
    expect(await api.prisma.externalIdentity.count({ where: { userId: u.id } })).toBe(0);
  });

  it('gives unknown people no account, unless one tenant allows their domain', async () => {
    const domain = `it-${unique()}.example`;
    expect(await linker.resolve(providerId, { subject: `sub-${unique()}`, email: `a@${domain}`, emailVerified: true })).toBeNull();

    const t = await api.prisma.tenant.create({ data: { name: `IT ${unique()}`, slug: `it-${unique()}`, organizationId: ctx.acme.organizationId, allowedEmailDomains: [domain] } });
    const joined = await linker.resolve(providerId, { subject: `sub-${unique()}`, email: `b@${domain}`, emailVerified: true, name: 'B' });
    expect(joined).not.toBeNull();
    const m = await api.prisma.membership.findMany({ where: { userId: joined!.id } });
    expect(m).toEqual([expect.objectContaining({ tenantId: t.id, role: 'CustomerViewer' })]);

    // A second tenant claims the domain: nobody can tell which customer, so no account.
    await api.prisma.tenant.create({ data: { name: `IT ${unique()}`, slug: `it-${unique()}`, organizationId: ctx.acme.organizationId, allowedEmailDomains: [domain] } });
    expect(await linker.resolve(providerId, { subject: `sub-${unique()}`, email: `c@${domain}`, emailVerified: true })).toBeNull();
  });

  it('creates the account from pending invitations and accepts them', async () => {
    const email = `invited-${unique()}@example.local`;
    await api.prisma.invitation.create({
      data: { tenantId: ctx.acme.id, email, role: 'CustomerDeveloper', tokenHash: `t-${unique()}`, expiresAt: new Date(Date.now() + 86_400_000) },
    });
    const created = await linker.resolve(providerId, { subject: `sub-${unique()}`, email, emailVerified: true });
    expect(created?.email).toBe(email);
    expect(await api.prisma.membership.findFirst({ where: { userId: created!.id, tenantId: ctx.acme.id } })).toMatchObject({ role: 'CustomerDeveloper' });
    expect(await api.prisma.invitation.count({ where: { email, acceptedAt: null } })).toBe(0);
  });

  it('refuses disabled accounts', async () => {
    const u = await newUser();
    await api.prisma.user.update({ where: { id: u.id }, data: { disabledAt: new Date() } });
    expect(await linker.resolve(providerId, { subject: `sub-${unique()}`, email: u.email, emailVerified: true })).toBeNull();
  });

  it('takes from GitHub only the primary email, and only when it is verified', () => {
    const emails = [
      { email: 'old@example.local', primary: false, verified: true },
      { email: 'main@example.local', primary: true, verified: true },
    ];
    expect(githubIdentity({ id: 42, login: 'octo', name: null }, emails)).toEqual({ subject: '42', email: 'main@example.local', emailVerified: true, name: 'octo' });
    const unverified = githubIdentity({ id: 7, login: 'x' }, [{ email: 'main@example.local', primary: true, verified: false }]);
    expect(unverified.emailVerified).toBe(false);
    expect(unverified.email).toBeUndefined();
  });
});

describe('sessions', () => {
  it('lists the own sessions, revokes one, and the revoked one stops working', async () => {
    const email = (await newUser()).email;
    const laptop = await api.as(email);
    const phone = await api.as(email, { fresh: true });
    const list = await laptop.get('/me/sessions');
    expect(list.status).toBe(200);
    expect(list.body.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    const other = list.body.find((s: { current: boolean }) => !s.current);
    expect(other).toBeDefined();

    expect((await laptop.del(`/me/sessions/${other.id}`)).status).toBe(204);
    expect((await phone.get('/me')).status).toBe(401);
    expect((await laptop.get('/me')).status).toBe(200);
  });

  it("cannot see or revoke someone else's session", async () => {
    const mine = await api.as((await newUser()).email);
    const theirs = (await admin.get('/me/sessions')).body[0];
    expect((await mine.del(`/me/sessions/${theirs.id}`)).status).toBe(404);
    expect((await mine.get('/me/sessions')).body.some((s: { id: string }) => s.id === theirs.id)).toBe(false);
  });

  it('signs every other session out', async () => {
    const email = (await newUser()).email;
    const a = await api.as(email);
    const b = await api.as(email, { fresh: true });
    expect((await a.post('/me/sessions/revoke-others')).body.revoked).toBeGreaterThanOrEqual(1);
    expect((await b.get('/me')).status).toBe(401);
    expect((await a.get('/me')).status).toBe(200);
  });
});
