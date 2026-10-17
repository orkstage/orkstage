// SPDX-License-Identifier: AGPL-3.0-only
import 'reflect-metadata';
import { createPrismaClient, type PrismaClient } from '@orkstage/database';
import { loadConfig } from '@orkstage/runtime';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { randomUUID } from 'node:crypto';
// The built app: tsc emits the decorator metadata Nest's injection needs, vitest's compiler does not.
import { createApp } from '../dist/app.js';

export interface Reply<T = any> {
  status: number;
  body: T;
}

export interface Caller {
  request<T = any>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Reply<T>>;
  get<T = any>(path: string): Promise<Reply<T>>;
  post<T = any>(path: string, body?: unknown): Promise<Reply<T>>;
  patch<T = any>(path: string, body?: unknown): Promise<Reply<T>>;
  del<T = any>(path: string): Promise<Reply<T>>;
}

export interface Api {
  app: NestFastifyApplication;
  prisma: PrismaClient;
  /** A cookie session, signed in through the development login (created on first use). */
  /** Signs in (once per email, unless `fresh` asks for another session). */
  as(email: string, opts?: { fresh?: boolean }): Promise<Caller>;
  /** Requests authenticated with an API key token. */
  withKey(token: string): Caller;
  /** Requests without credentials. */
  anonymous(): Caller;
  close(): Promise<void>;
}

let lastAddress = 0;
/** Test files run in their own processes and share Redis: each starts in its own address range. */
const addressBase = Math.floor(Math.random() * 250) * 250;
/**
 * Each caller gets its own client address (the API trusts one proxy hop), so the per address
 * limits of sign in and the rate limit tests do not spill over between callers.
 */
export const nextAddress = () => {
  const n = addressBase + ++lastAddress;
  return `10.${Math.floor(n / 62_500) % 250}.${Math.floor(n / 250) % 250}.${(n % 250) + 1}`;
};

/** A unique suffix for names and slugs, so the suite can run again on the same database. */
export const unique = () => randomUUID().slice(0, 8);

export const items = <T>(body: T[] | { items: T[] }): T[] => (Array.isArray(body) ? body : body.items);

export async function startApi(): Promise<Api> {
  process.env.AUTH_DEV_LOGIN_ENABLED ??= 'true';
  process.env.LOG_LEVEL ??= 'error';
  process.env.SESSION_SECRET ??= 'integration-tests-session-secret-0123456789';
  const app = await createApp(loadConfig());
  await app.init();
  const fastify = app.getHttpAdapter().getInstance();
  await fastify.ready();
  const prisma = createPrismaClient();

  const caller = (auth: Record<string, string>, address = nextAddress()): Caller => {
    const request = async <T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply<T>> => {
      const mutating = method !== 'GET';
      const res = await fastify.inject({
        method: method as 'GET',
        url: `/api/v1${path}`,
        headers: {
          'x-forwarded-for': address,
          ...auth,
          ...(mutating ? { 'content-type': 'application/json', 'x-orkstage-csrf': '1' } : {}),
          ...headers,
        },
        ...(mutating ? { payload: JSON.stringify(body ?? {}) } : {}),
      });
      const text = res.body;
      return { status: res.statusCode, body: text ? (JSON.parse(text) as T) : (undefined as T) };
    };
    return {
      request,
      get: (path) => request('GET', path),
      post: (path, body) => request('POST', path, body),
      patch: (path, body) => request('PATCH', path, body),
      del: (path) => request('DELETE', path),
    };
  };

  const sessions = new Map<string, Caller>();
  return {
    app,
    prisma,
    async as(email, opts) {
      const known = opts?.fresh ? undefined : sessions.get(email);
      if (known) return known;
      const address = nextAddress();
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/v1/auth/dev-login',
        headers: { 'content-type': 'application/json', 'x-orkstage-csrf': '1', 'x-forwarded-for': address },
        payload: JSON.stringify({ email }),
      });
      if (res.statusCode >= 300) throw new Error(`dev login for ${email}: ${res.statusCode} ${res.body}`);
      const cookie = res.cookies.find((c) => c.name === 'orkstage_session');
      if (!cookie) throw new Error(`dev login for ${email} set no session cookie`);
      const c = caller({ cookie: `orkstage_session=${cookie.value}` }, address);
      sessions.set(email, c);
      return c;
    },
    withKey: (token) => caller({ authorization: `Bearer ${token}` }),
    anonymous: () => caller({}),
    async close() {
      await app.close();
      await prisma.$disconnect();
    },
  };
}

/** The seeded demo data the suite relies on (SEED_DEMO_DATA, the default outside production). */
export async function demo(prisma: PrismaClient) {
  const [acme, globex, starter] = await Promise.all([
    prisma.tenant.findUniqueOrThrow({ where: { slug: 'acme' } }),
    prisma.tenant.findUniqueOrThrow({ where: { slug: 'globex' } }),
    prisma.templateVersion.findFirstOrThrow({ where: { template: { name: 'starter-standard' }, status: 'PUBLISHED' } }),
  ]);
  return { acme, globex, starterVersionId: starter.id, admin: 'admin@example.local', operator: 'operator@example.local', acmeOwner: 'customer@example.local' };
}

/** A user with one membership, created directly in the database (the API invites by email). */
export async function member(prisma: PrismaClient, tenantId: string, role: 'CustomerOwner' | 'CustomerAdmin' | 'CustomerDeveloper' | 'CustomerViewer') {
  const email = `it-${role.toLowerCase()}-${unique()}@example.local`;
  const user = await prisma.user.create({ data: { email, name: email } });
  await prisma.membership.create({ data: { tenantId, userId: user.id, role } });
  return { email, userId: user.id };
}

/** A user without memberships, created directly in the database (the development login needs one). */
export async function user(prisma: PrismaClient, email = `it-user-${unique()}@example.local`) {
  await prisma.user.upsert({ where: { email }, update: {}, create: { email, name: email } });
  return email;
}

/** A tenant of its own with no limits, created by platform staff, so reruns never hit a quota. */
export async function tenant(admin: Caller, prefix = 'it') {
  const slug = `${prefix}-${unique()}`;
  const res = await admin.post('/tenants', { name: `Integration ${slug}`, slug });
  if (res.status !== 201) throw new Error(`create tenant: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { id: string; slug: string; name: string };
}
