import type { CloudTarget, ProviderContext, ResourceRequest } from '@orkstage/cloud-core';
import { runAdapterContract } from '@orkstage/cloud-core/testing';
import { describe, expect, it } from 'vitest';
import { databasePassword, SupabaseAdapter } from './adapter.js';
import { SUPABASE_CAPABILITIES } from './catalog.js';
import { logsQuery, projectHealth, servicesHealth, toIso } from './health.js';

const TOKEN = 'sbp_' + 'x'.repeat(40);
const SERVICE_KEY = 'eyJ' + 's'.repeat(60);
const ANON_KEY = 'eyJ' + 'a'.repeat(60);

const target: CloudTarget = {
  id: 't1',
  provider: 'supabase',
  name: 'Acme data',
  config: { organizationId: 'acme' },
  credentialRef: 'env://SUPABASE_TOKEN',
  allowedRegions: ['sa-east-1', 'us-east-1', 'mars-1'],
  defaultRegion: 'sa-east-1',
};

interface FakeProject {
  ref: string;
  name: string;
  organization_slug: string;
  organization_id: string;
  region: string;
  status: string;
  polls: number;
}

interface Call {
  method: string;
  url: URL;
  body?: Record<string, unknown>;
  headers: Record<string, string>;
}

/** In-memory Supabase: Management API plus each project's Storage API. */
function fakeSupabase() {
  const state = {
    plan: 'pro',
    projects: new Map<string, FakeProject>(),
    buckets: new Map<string, { id: string; name: string; public: boolean; objects: number }>(),
    health: undefined as unknown[] | undefined,
    logs: [] as unknown[],
    calls: [] as Call[],
    fail: undefined as { status: number; body: unknown } | undefined,
  };
  let seq = 0;
  const json = (status: number, data?: unknown) => new Response(data === undefined ? null : JSON.stringify(data), { status });
  const view = (p: FakeProject) => ({
    id: p.ref,
    ref: p.ref,
    name: p.name,
    organization_slug: p.organization_slug,
    organization_id: p.organization_id,
    region: p.region,
    status: p.status,
    created_at: '2026-10-09T00:00:00Z',
    database: { host: `db.${p.ref}.supabase.co`, version: '17.4', postgres_engine: '17', release_channel: 'ga' },
  });

  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    state.calls.push({ method, url, body, headers: (init?.headers ?? {}) as Record<string, string> });
    if (state.fail) return json(state.fail.status, state.fail.body);

    if (url.host === 'api.supabase.com') {
      const p = url.pathname;
      if (p === '/v1/organizations') return json(200, [{ id: 'acme', slug: 'acme', name: 'Acme' }]);
      if (p === '/v1/organizations/acme') return json(200, { id: 'acme', name: 'Acme', plan: state.plan });
      if (p === '/v1/projects' && method === 'GET') return json(200, [...state.projects.values()].map(view));
      if (p === '/v1/projects' && method === 'POST') {
        const ref = `abcdefghijklmnopqrs${String.fromCharCode(97 + seq++)}`;
        const region = (body!.region_selection as { code: string }).code;
        const project = { ref, name: String(body!.name), organization_slug: String(body!.organization_slug), organization_id: 'acme', region, status: 'COMING_UP', polls: 2 };
        state.projects.set(ref, project);
        return json(201, view(project));
      }
      const m = /^\/v1\/projects\/([a-z]+)(\/.*)?$/.exec(p);
      const project = m ? state.projects.get(m[1]!) : undefined;
      if (!m || !project) return json(404, { message: 'Project not found' });
      const sub = m[2] ?? '';
      if (sub === '' && method === 'GET') {
        if (project.status === 'COMING_UP' && --project.polls <= 0) project.status = 'ACTIVE_HEALTHY';
        return json(200, view(project));
      }
      if (sub === '' && method === 'DELETE') {
        state.projects.delete(project.ref);
        return json(200, { id: 1, ref: project.ref, name: project.name });
      }
      if (sub === '/api-keys') {
        return json(200, [
          { name: 'anon', type: 'legacy', api_key: ANON_KEY },
          { name: 'service_role', type: 'legacy', api_key: SERVICE_KEY },
        ]);
      }
      if (sub === '/config/database/pooler') {
        return json(200, [
          { identifier: project.ref, database_type: 'PRIMARY', db_user: `postgres.${project.ref}`, db_host: `aws-0-${project.region}.pooler.supabase.com`, db_port: 6543, db_name: 'postgres', pool_mode: 'transaction' },
        ]);
      }
      if (sub === '/health') {
        const names = String(url.searchParams.get('services')).split(',');
        return json(200, state.health ?? names.map((name) => ({ name, healthy: true, status: 'ACTIVE_HEALTHY' })));
      }
      if (sub === '/restart' || sub === '/pause' || sub === '/restore') return json(200);
      if (sub === '/database/backups/restore-point') return json(201, { name: body!.name, status: 'PENDING', completed_on: null });
      if (sub === '/analytics/endpoints/logs') return json(200, { result: state.logs });
      return json(404, { message: 'no route' });
    }

    const ref = url.host.replace('.supabase.co', '');
    if (!state.projects.has(ref)) return json(404, {});
    if (init?.headers && (init.headers as Record<string, string>).apikey !== SERVICE_KEY) return json(403, { message: 'bad key' });
    const b = /^\/storage\/v1\/bucket(?:\/([^/]+))?(\/empty)?$/.exec(url.pathname);
    if (!b) return json(404, {});
    const id = b[1];
    const key = `${ref}/${id ?? body?.id}`;
    const bucket = state.buckets.get(key);
    if (!id && method === 'POST') {
      state.buckets.set(key, { id: String(body!.id), name: String(body!.name), public: Boolean(body!.public), objects: 0 });
      return json(200, { name: body!.name });
    }
    if (!bucket) return json(400, { statusCode: '404', error: 'Bucket not found', message: 'Bucket not found' });
    if (b[2] && method === 'POST') {
      bucket.objects = 0;
      return json(200, { message: 'Successfully emptied' });
    }
    if (method === 'GET') return json(200, { id: bucket.id, name: bucket.name, public: bucket.public, owner: '', created_at: '', updated_at: '' });
    if (method === 'PUT') {
      bucket.public = Boolean(body!.public);
      return json(200, { message: 'Successfully updated' });
    }
    if (method === 'DELETE') {
      if (bucket.objects > 0) return json(409, { statusCode: '409', error: 'InvalidRequest', message: 'The bucket you tried to delete is not empty' });
      state.buckets.delete(key);
      return json(200, { message: 'Successfully deleted' });
    }
    return json(404, {});
  }) as typeof fetch;

  return { state, fetchFn };
}

const derive = (purpose: string) => `derived(${purpose})`;

function setup(over: Partial<ProviderContext> = {}) {
  const fake = fakeSupabase();
  const logs: string[] = [];
  const adapter = new SupabaseAdapter({ resolveSecret: async () => TOKEN, fetch: fake.fetchFn, deriveSecret: derive, pollIntervalMs: 1, pollTimeoutMs: 2_000 });
  const ctx: ProviderContext = { target, region: 'sa-east-1', correlationId: 'c1', log: (_l, m) => logs.push(m), ...over };
  return { ...fake, adapter, ctx, logs };
}

const dbRequest = (over: Partial<ResourceRequest> = {}): ResourceRequest => ({
  resourceId: 'db',
  serviceKind: 'database.postgresql',
  capability: 'supabase-postgres',
  name: 'ork-acme-prod-db',
  tags: { 'platform:managed': 'true', 'platform:environment': 'production' },
  spec: { version: '17', size: 'small', storageGiB: 20, highAvailability: 'none', publicAccess: false },
  dependencyOutputs: {},
  idempotencyKey: 'k1',
  ...over,
});

const bucketRequest = (deps: ResourceRequest['dependencyOutputs'], over: Partial<ResourceRequest> = {}): ResourceRequest => ({
  resourceId: 'files',
  serviceKind: 'object-storage',
  capability: 'supabase-storage',
  name: 'ork-acme-prod-files',
  tags: { 'platform:environment': 'staging' },
  spec: { tier: 'standard', versioning: false, publicAccess: true },
  dependencyOutputs: deps,
  idempotencyKey: 'k2',
  ...over,
});

describe('catalog', () => {
  it('has one default per kind and the brief pricing source', () => {
    expect(SUPABASE_CAPABILITIES.map((c) => c.capability)).toEqual(['supabase-postgres', 'supabase-storage']);
    for (const c of SUPABASE_CAPABILITIES) expect(c.pricing?.source).toMatch(/^Static Supabase list prices, .*\(2026\)\. Not an invoice\.$/);
  });
});

describe('validateTarget', () => {
  it('confirms the token and the organization (identity is the org name)', async () => {
    const { adapter, ctx } = setup();
    const r = await adapter.validateTarget(ctx);
    expect(r.ok).toBe(true);
    expect(r.identity).toBe('Acme');
    expect(r.checks.map((c) => c.name)).toEqual(['Organization', 'Region', 'Credentials', 'Plan']);
  });

  it('reports an organization the token cannot see', async () => {
    const { adapter, ctx } = setup({ target: { ...target, config: { organizationId: 'other' } } });
    const r = await adapter.validateTarget(ctx);
    expect(r.ok).toBe(false);
    expect(r.checks.at(-1)).toMatchObject({ name: 'Organization access', status: 'error' });
  });

  it('rejects regions Supabase does not have, without calling the API', async () => {
    const { adapter, ctx, state } = setup({ region: 'mars-1' });
    const r = await adapter.validateTarget(ctx);
    expect(r.ok).toBe(false);
    expect(r.checks[1]).toMatchObject({ name: 'Region', status: 'error' });
    expect(state.calls).toHaveLength(0);
  });

  it('classifies a rejected token and keeps it out of the message', async () => {
    const { adapter, ctx, state } = setup();
    state.fail = { status: 401, body: { message: `Invalid token ${TOKEN}` } };
    const r = await adapter.validateTarget(ctx);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    await expect(adapter.ensureResource(ctx, dbRequest())).rejects.toMatchObject({ code: 'SUPABASE_API_ERROR', failureClass: 'AUTHENTICATION_ERROR' });
  });
});

describe('supabase-postgres', () => {
  it('creates a project with the derived password, waits for it and publishes outputs without secrets', async () => {
    const { adapter, ctx, state, logs } = setup();
    const res = await adapter.ensureResource(ctx, dbRequest());
    const create = state.calls.find((c) => c.method === 'POST' && c.url.pathname === '/v1/projects')!;
    const password = databasePassword(derive('supabase:db:t1:ork-acme-prod-db'));
    expect(create.body).toEqual({
      name: 'ork-acme-prod-db',
      organization_slug: 'acme',
      db_pass: password,
      region_selection: { type: 'specific', code: 'sa-east-1' },
      desired_instance_size: 'small',
    });
    expect(create.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(res.unchanged).toBe(false);
    const ref = res.providerResourceId;
    expect(res.outputs).toMatchObject({
      kind: 'database.postgresql',
      project_ref: ref,
      host: `db.${ref}.supabase.co`,
      port: 5432,
      database: 'postgres',
      username: 'postgres',
      api_url: `https://${ref}.supabase.co`,
      dashboard_url: `https://supabase.com/dashboard/project/${ref}`,
      pooler_host: 'aws-0-sa-east-1.pooler.supabase.com',
      pooler_port: 6543,
      secret_ref: `supabase://${ref}/database`,
    });
    expect(JSON.stringify(res.outputs)).not.toContain(password);
    expect(logs.join('\n')).toContain('COMING_UP');
    expect(logs.join('\n')).not.toContain(password);
  });

  it('makes strong, URL safe, deterministic passwords', () => {
    const a = databasePassword('seed');
    expect(a).toBe(databasePassword('seed'));
    expect(a).not.toBe(databasePassword('other'));
    expect(a).toMatch(/^[A-Za-z0-9]{32,35}$/);
    expect(a).toMatch(/[a-z]/);
    expect(a).toMatch(/[A-Z]/);
    expect(a).toMatch(/[0-9]/);
  });

  it('leaves the compute size to Supabase on the free plan', async () => {
    const { adapter, ctx, state } = setup();
    state.plan = 'free';
    await adapter.ensureResource(ctx, dbRequest());
    const create = state.calls.find((c) => c.method === 'POST' && c.url.pathname === '/v1/projects')!;
    expect(create.body).not.toHaveProperty('desired_instance_size');
  });

  it('reuses an existing project with the same name in the organization', async () => {
    const { adapter, ctx, state } = setup();
    const first = await adapter.ensureResource(ctx, dbRequest());
    const second = await adapter.ensureResource(ctx, dbRequest({ idempotencyKey: 'k9' }));
    expect(second).toMatchObject({ providerResourceId: first.providerResourceId, unchanged: true });
    expect(state.calls.filter((c) => c.method === 'POST' && c.url.pathname === '/v1/projects')).toHaveLength(1);
  });

  it('refuses to reuse a project that lives in another region', async () => {
    const { adapter, ctx } = setup();
    await adapter.ensureResource(ctx, dbRequest());
    await expect(adapter.ensureResource({ ...ctx, region: 'us-east-1' }, dbRequest())).rejects.toMatchObject({ code: 'SUPABASE_REGION_MISMATCH', failureClass: 'RESOURCE_CONFLICT' });
  });

  it('stops waiting when the deployment is cancelled', async () => {
    const controller = new AbortController();
    const { adapter, ctx, state } = setup({ signal: controller.signal });
    const run = adapter.ensureResource(ctx, dbRequest());
    controller.abort();
    await expect(run).rejects.toMatchObject({ failureClass: 'TIMEOUT' });
    expect(state.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('readSecret builds connection strings from the derived password', async () => {
    const { adapter, ctx } = setup();
    const { providerResourceId: ref } = await adapter.ensureResource(ctx, dbRequest());
    const secret = await adapter.readSecret(ctx, `supabase://${ref}/database`);
    const password = databasePassword(derive('supabase:db:t1:ork-acme-prod-db'));
    expect(secret).toEqual({
      url: `postgresql://postgres:${password}@db.${ref}.supabase.co:5432/postgres?sslmode=require`,
      poolerUrl: `postgresql://postgres.${ref}:${password}@aws-0-sa-east-1.pooler.supabase.com:6543/postgres?sslmode=require`,
      username: 'postgres',
      password,
      host: `db.${ref}.supabase.co`,
      port: '5432',
      database: 'postgres',
    });
    await expect(adapter.readSecret(ctx, 'supabase://nope/database')).rejects.toMatchObject({ code: 'SUPABASE_PROJECT_NOT_FOUND' });
    await expect(adapter.readSecret(ctx, 'aws-sm://x')).rejects.toMatchObject({ code: 'SUPABASE_SECRET_REF_INVALID' });
  });

  it('deletes the project, and a missing project is fine', async () => {
    const { adapter, ctx, state } = setup();
    const req = dbRequest();
    const { providerResourceId } = await adapter.ensureResource(ctx, req);
    await adapter.deleteResource(ctx, { ...req, providerResourceId });
    await adapter.deleteResource(ctx, { ...req, providerResourceId });
    expect(state.projects.size).toBe(0);
    expect(await adapter.probeExists(ctx, { ...req, providerResourceId })).toBe(false);
  });
});

describe('supabase-storage', () => {
  it('needs a Supabase database dependency', async () => {
    const { adapter, ctx } = setup();
    await expect(adapter.ensureResource(ctx, bucketRequest({}))).rejects.toMatchObject({ code: 'SUPABASE_MISSING_DEPENDENCY', failureClass: 'VALIDATION_ERROR' });
    await expect(adapter.ensureResource(ctx, bucketRequest({ db: { kind: 'database.postgresql', host: 'rds.example.com' } }))).rejects.toMatchObject({
      code: 'SUPABASE_MISSING_DEPENDENCY',
    });
  });

  it('creates the bucket with the service role key, converges the public flag and shares keys by reference', async () => {
    const { adapter, ctx, state } = setup();
    const db = await adapter.ensureResource(ctx, dbRequest());
    const ref = db.providerResourceId;
    const req = bucketRequest({ db: db.outputs });
    const first = await adapter.ensureResource(ctx, req);
    expect(first).toMatchObject({ providerResourceId: `${ref}/ork-acme-prod-files`, unchanged: false });
    expect(first.outputs).toMatchObject({
      kind: 'object-storage',
      bucket: 'ork-acme-prod-files',
      endpoint: `https://${ref}.supabase.co/storage/v1/s3`,
      region: 'sa-east-1',
      public_url: `https://${ref}.supabase.co/storage/v1/object/public/ork-acme-prod-files`,
      deletion_protected: false,
      secret_ref: `supabase://${ref}/storage`,
    });
    expect(JSON.stringify(first.outputs)).not.toContain(SERVICE_KEY);
    const create = state.calls.find((c) => c.method === 'POST' && c.url.pathname === '/storage/v1/bucket')!;
    expect(create.body).toEqual({ id: 'ork-acme-prod-files', name: 'ork-acme-prod-files', public: true });
    expect(create.headers).toMatchObject({ apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}` });

    expect((await adapter.ensureResource(ctx, req)).unchanged).toBe(true);
    const flipped = await adapter.ensureResource(ctx, { ...req, spec: { ...req.spec, publicAccess: false } });
    expect(flipped.unchanged).toBe(false);
    expect(state.buckets.get(`${ref}/ork-acme-prod-files`)?.public).toBe(false);

    expect(await adapter.readSecret(ctx, `supabase://${ref}/storage`)).toEqual({ url: `https://${ref}.supabase.co`, serviceRoleKey: SERVICE_KEY, anonKey: ANON_KEY });
  });

  it('empties unprotected buckets before deleting; protected ones are never emptied', async () => {
    const { adapter, ctx, state } = setup();
    const db = await adapter.ensureResource(ctx, dbRequest());
    const ref = db.providerResourceId;
    const req = bucketRequest({ db: db.outputs });
    const created = await adapter.ensureResource(ctx, req);
    const key = `${ref}/ork-acme-prod-files`;
    state.buckets.get(key)!.objects = 3;

    const ident = { ...req, providerResourceId: created.providerResourceId };
    await expect(adapter.deleteResource(ctx, { ...ident, outputs: { ...created.outputs, deletion_protected: true } })).rejects.toMatchObject({
      code: 'SUPABASE_BUCKET_NOT_EMPTY',
      failureClass: 'POLICY_VIOLATION',
    });
    expect(state.buckets.get(key)?.objects).toBe(3);

    await adapter.deleteResource(ctx, { ...ident, outputs: created.outputs });
    expect(state.buckets.has(key)).toBe(false);
    await adapter.deleteResource(ctx, { ...ident, outputs: created.outputs });
    expect((await adapter.getResource(ctx, ident)).exists).toBe(false);
  });
});

describe('health', () => {
  it('maps project status', () => {
    expect(projectHealth('ACTIVE_HEALTHY')).toBeUndefined();
    expect(projectHealth('COMING_UP')?.state).toBe('DEGRADED');
    expect(projectHealth('INACTIVE')).toMatchObject({ state: 'UNHEALTHY', message: expect.stringContaining('paused') });
    expect(projectHealth('INIT_FAILED')?.state).toBe('UNHEALTHY');
  });

  it('maps service health with the database as the critical service', () => {
    const s = (name: string, status: 'ACTIVE_HEALTHY' | 'COMING_UP' | 'UNHEALTHY') => ({ name, status });
    expect(servicesHealth([s('db', 'ACTIVE_HEALTHY'), s('rest', 'ACTIVE_HEALTHY')], 'db').state).toBe('HEALTHY');
    expect(servicesHealth([s('db', 'ACTIVE_HEALTHY'), s('auth', 'UNHEALTHY')], 'db')).toEqual({ state: 'DEGRADED', message: 'Unhealthy: auth.' });
    expect(servicesHealth([s('db', 'UNHEALTHY')], 'db').state).toBe('UNHEALTHY');
    expect(servicesHealth([s('db', 'COMING_UP')], 'db').state).toBe('DEGRADED');
    expect(servicesHealth([], 'db').state).toBe('UNKNOWN');
  });

  it('checks the project and its services', async () => {
    const { adapter, ctx, state } = setup();
    const req = dbRequest();
    const { providerResourceId } = await adapter.ensureResource(ctx, req);
    const ident = { ...req, providerResourceId };
    expect((await adapter.checkHealth(ctx, ident)).state).toBe('HEALTHY');
    const healthCall = state.calls.find((c) => c.url.pathname.endsWith('/health'))!;
    expect(healthCall.url.searchParams.get('services')).toBe('db,rest,auth,storage');

    state.health = [{ name: 'db', status: 'UNHEALTHY', healthy: false }];
    expect((await adapter.checkHealth(ctx, ident)).state).toBe('UNHEALTHY');

    state.projects.get(providerResourceId)!.status = 'INACTIVE';
    expect(await adapter.checkHealth(ctx, ident)).toMatchObject({ state: 'UNHEALTHY', message: expect.stringContaining('paused') });

    state.projects.clear();
    expect((await adapter.checkHealth(ctx, ident)).state).toBe('UNHEALTHY');
  });
});

describe('logs', () => {
  it('queries the unified logs stream for the capability source, oldest first', async () => {
    const { adapter, ctx, state } = setup();
    const req = dbRequest();
    const { providerResourceId } = await adapter.ensureResource(ctx, req);
    state.logs = [
      { timestamp: 1760000060000000, event_message: 'ERROR: relation "x" does not exist' },
      { timestamp: '2025-10-09T08:53:20Z', event_message: 'checkpoint complete' },
    ];
    const lines = await adapter.getLogs(ctx, { ...req, providerResourceId }, 50);
    const call = state.calls.find((c) => c.url.pathname.endsWith('/analytics/endpoints/logs'))!;
    expect(call.url.searchParams.get('sql')).toBe(logsQuery('postgres_logs', 50));
    expect(call.url.searchParams.get('iso_timestamp_start')).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(lines.map((l) => l.level)).toEqual(['info', 'error']);
    expect(lines[1]!.timestamp).toBe('2025-10-09T08:54:20.000Z');
    expect(toIso(1760000000)).toBe('2025-10-09T08:53:20.000Z');
  });
});

describe('actions', () => {
  it('offers project operations on the database only', () => {
    const { adapter } = setup();
    expect(adapter.actions('supabase-postgres').map((a) => a.name)).toEqual(['restart', 'pause', 'restore', 'backup']);
    expect(adapter.actions('supabase-storage')).toEqual([]);
  });

  it('runs actions against the project and validates parameters', async () => {
    const { adapter, ctx, state } = setup();
    const req = dbRequest();
    const { providerResourceId: ref } = await adapter.ensureResource(ctx, req);
    const ident = { ...req, providerResourceId: ref };

    for (const action of ['restart', 'pause', 'restore']) {
      const r = await adapter.runAction(ctx, ident, { action, params: {} });
      expect(r).toMatchObject({ status: 'started', url: `https://supabase.com/dashboard/project/${ref}` });
      expect(state.calls.at(-1)).toMatchObject({ method: 'POST' });
      expect(state.calls.at(-1)!.url.pathname).toBe(`/v1/projects/${ref}/${action}`);
    }

    const backup = await adapter.runAction(ctx, ident, { action: 'backup', params: { name: 'before-upgrade' } });
    expect(backup).toMatchObject({ reference: 'before-upgrade', status: 'started' });
    expect(state.calls.at(-1)!.body).toEqual({ name: 'before-upgrade' });
    const auto = await adapter.runAction(ctx, ident, { action: 'backup', params: {} });
    expect(auto.reference).toMatch(/^ork-\d{12}$/);

    await expect(adapter.runAction(ctx, ident, { action: 'restart', params: { force: true } })).rejects.toMatchObject({ code: 'SUPABASE_ACTION_PARAMS' });
    await expect(adapter.runAction(ctx, ident, { action: 'backup', params: { name: 42 } })).rejects.toMatchObject({ code: 'SUPABASE_ACTION_PARAMS' });
    await expect(adapter.runAction(ctx, ident, { action: 'backup', params: { name: 'a name that is far too long' } })).rejects.toMatchObject({ code: 'SUPABASE_ACTION_PARAMS' });
    await expect(adapter.runAction(ctx, ident, { action: 'redeploy', params: {} })).rejects.toMatchObject({ code: 'SUPABASE_ACTION_UNKNOWN', failureClass: 'VALIDATION_ERROR' });
  });
});

runAdapterContract('SupabaseAdapter', () => {
  const { adapter, ctx } = setup();
  return { adapter, context: ctx, sampleRequest: dbRequest() };
});
