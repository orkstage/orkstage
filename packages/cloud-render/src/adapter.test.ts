// SPDX-License-Identifier: AGPL-3.0-only
import type { CloudTarget, ProviderContext, ResourceRequest } from '@orkstage/cloud-core';
import { runAdapterContract } from '@orkstage/cloud-core/testing';
import { describe, expect, it } from 'vitest';
import { RenderAdapter } from './adapter.js';
import { RENDER_CAPABILITIES } from './catalog.js';
import { servicePlan } from './plans.js';

const API_KEY = 'rnd_testkey_000000000000';
const PG_PASSWORD = 'pg-secret-password-123456';
const KV_PASSWORD = 'kv-secret-password-654321';

type Json = Record<string, any>;

/** In memory stand in for the parts of api.render.com/v1 the adapter uses. */
class FakeRender {
  services = new Map<string, Json>();
  postgres = new Map<string, Json>();
  keyValues = new Map<string, Json>();
  calls: { method: string; path: string; query: URLSearchParams; body?: any }[] = [];
  /** Status returned by the public URL of web services and static sites. */
  siteStatus = 200;
  failNext?: { method: string; path: RegExp; status: number; message: string };
  private seq = 0;

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    if (url.hostname !== 'api.render.com') return new Response('ok', { status: this.siteStatus });
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const path = url.pathname.replace(/^\/v1/, '');
    this.calls.push({ method, path, query: url.searchParams, body });
    const auth = (init?.headers as Record<string, string>)?.Authorization;
    if (auth !== `Bearer ${API_KEY}`) return this.json(401, { id: 'unauthorized', message: 'unauthorized' });
    if (this.failNext && this.failNext.method === method && this.failNext.path.test(path)) {
      const { status, message } = this.failNext;
      this.failNext = undefined;
      return this.json(status, { id: 'error', message });
    }
    return this.route(method, path, url.searchParams, body);
  };

  private json(status: number, body?: unknown): Response {
    return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }

  private id(prefix: string) {
    this.seq += 1;
    return `${prefix}-d${this.seq}abc`;
  }

  private filter(rows: Json[], q: URLSearchParams, key: string) {
    const names = q.getAll('name');
    const owners = q.getAll('ownerId');
    return rows
      .filter((r) => (!names.length || names.includes(r.name)) && (!owners.length || owners.includes(r.ownerId ?? r.owner?.id)))
      .map((r) => ({ [key]: this.view(r), cursor: r.id }));
  }

  /** Public view of a stored service (internal fields stripped). */
  private view(r: Json) {
    const { env: _env, domains: _domains, deploys: _deploys, ...rest } = r;
    return rest;
  }

  private deploy(svc: Json, extra: Json = {}) {
    const d = { id: this.id('dep'), status: 'live', trigger: 'api', commit: { id: 'c0ffee', message: 'Initial' }, createdAt: '2026-10-01T00:00:00Z', ...extra };
    for (const old of svc.deploys) if (old.status === 'live') old.status = 'deactivated';
    svc.deploys.unshift(d);
    return d;
  }

  private route(method: string, path: string, q: URLSearchParams, body: any): Response {
    let m: RegExpMatchArray | null;
    if ((m = path.match(/^\/owners\/([\w-]+)$/))) return m[1] === 'tea-acme' ? this.json(200, { id: 'tea-acme', name: 'Acme', email: 'ops@acme.test', type: 'team' }) : this.json(404, { message: 'not found' });

    // Services
    if (path === '/services' && method === 'GET') return this.json(200, this.filter([...this.services.values()], q, 'service'));
    if (path === '/services' && method === 'POST') {
      const id = this.id('srv');
      const svc: Json = {
        id,
        name: body.name,
        ownerId: body.ownerId,
        type: body.type,
        slug: `${body.name}-x1y2`,
        repo: body.repo,
        branch: body.branch,
        rootDir: body.rootDir ?? '',
        imagePath: body.image?.imagePath,
        dashboardUrl: `https://dashboard.render.com/web/${id}`,
        suspended: 'not_suspended',
        suspenders: [],
        serviceDetails: {
          ...body.serviceDetails,
          numInstances: body.serviceDetails?.numInstances ?? 1,
          ...(body.type !== 'private_service' ? { url: `https://${body.name}.onrender.com` } : {}),
        },
        env: body.envVars ?? [],
        domains: [],
        deploys: [],
      };
      this.services.set(id, svc);
      const dep = this.deploy(svc);
      return this.json(201, { service: this.view(svc), deployId: dep.id });
    }
    if ((m = path.match(/^\/services\/([\w-]+)(\/.*)?$/))) {
      const svc = this.services.get(m[1]!);
      if (!svc) return this.json(404, { message: 'service not found' });
      const sub = m[2] ?? '';
      if (!sub && method === 'GET') return this.json(200, this.view(svc));
      if (!sub && method === 'DELETE') {
        this.services.delete(svc.id);
        return this.json(204);
      }
      if (!sub && method === 'PATCH') {
        const { serviceDetails, image, ...top } = body;
        Object.assign(svc, top);
        if (image) svc.imagePath = image.imagePath;
        if (serviceDetails) svc.serviceDetails = { ...svc.serviceDetails, ...serviceDetails };
        return this.json(200, this.view(svc));
      }
      if (sub === '/env-vars' && method === 'GET') return this.json(200, svc.env.map((e: Json) => ({ envVar: e, cursor: e.key })));
      if (sub === '/env-vars' && method === 'PUT') {
        svc.env = body;
        return this.json(200, body.map((e: Json) => ({ envVar: e, cursor: e.key })));
      }
      if (sub === '/custom-domains' && method === 'GET') return this.json(200, svc.domains.map((d: Json) => ({ customDomain: d, cursor: d.id })));
      if (sub === '/custom-domains' && method === 'POST') {
        const d = { id: this.id('cdm'), name: body.name, domainType: 'subdomain', verificationStatus: 'verified' };
        svc.domains.push(d);
        return this.json(201, [d]);
      }
      if (sub === '/deploys' && method === 'GET') {
        const limit = Number(q.get('limit') ?? 20);
        return this.json(200, svc.deploys.slice(0, limit).map((d: Json) => ({ deploy: d, cursor: d.id })));
      }
      if (sub === '/deploys' && method === 'POST') return this.json(201, this.deploy(svc, { status: 'build_in_progress', commit: body.commitId ? { id: body.commitId } : undefined }));
      if (sub === '/rollback' && method === 'POST') return this.json(201, this.deploy(svc, { status: 'update_in_progress', trigger: 'rollback' }));
      if (sub === '/restart') return this.json(200);
      if (sub === '/suspend') {
        svc.suspended = 'suspended';
        svc.suspenders = ['user'];
        return this.json(202);
      }
      if (sub === '/resume') {
        svc.suspended = 'not_suspended';
        svc.suspenders = [];
        return this.json(202);
      }
      if (sub === '/scale') {
        svc.serviceDetails.numInstances = body.numInstances;
        return this.json(202);
      }
      if (sub === '/autoscaling' && method === 'PUT') {
        svc.serviceDetails.autoscaling = body;
        return this.json(200, body);
      }
      if (sub === '/autoscaling' && method === 'DELETE') {
        delete svc.serviceDetails.autoscaling;
        return this.json(204);
      }
    }

    // Postgres
    if (path === '/postgres' && method === 'GET') return this.json(200, this.filter([...this.postgres.values()], q, 'postgres'));
    if (path === '/postgres' && method === 'POST') {
      const id = `dpg-${this.id('x')}-a`;
      const pg = {
        id,
        name: body.name,
        owner: { id: body.ownerId, name: 'Acme' },
        plan: body.plan,
        region: body.region,
        version: body.version,
        status: 'creating',
        suspended: 'not_suspended',
        suspenders: [],
        databaseName: body.databaseName,
        databaseUser: body.databaseUser,
        diskSizeGB: body.diskSizeGB,
        highAvailabilityEnabled: body.enableHighAvailability ?? false,
        ipAllowList: body.ipAllowList ?? [{ cidrBlock: '0.0.0.0/0', description: 'everywhere' }],
        dashboardUrl: `https://dashboard.render.com/d/${id}`,
      };
      this.postgres.set(id, pg);
      return this.json(201, pg);
    }
    if ((m = path.match(/^\/postgres\/([\w-]+)(\/.*)?$/))) {
      const pg = this.postgres.get(m[1]!);
      if (!pg) return this.json(404, { message: 'not found' });
      const sub = m[2] ?? '';
      if (!sub && method === 'GET') return this.json(200, pg);
      if (!sub && method === 'DELETE') {
        this.postgres.delete(pg.id);
        return this.json(204);
      }
      if (!sub && method === 'PATCH') {
        const { enableHighAvailability, ...rest } = body;
        Object.assign(pg, rest, enableHighAvailability === undefined ? {} : { highAvailabilityEnabled: enableHighAvailability });
        return this.json(200, pg);
      }
      if (sub === '/connection-info') {
        const auth = `${pg.databaseUser}:${PG_PASSWORD}`;
        return this.json(200, {
          password: PG_PASSWORD,
          internalConnectionString: `postgresql://${auth}@${pg.id}/${pg.databaseName}`,
          externalConnectionString: `postgresql://${auth}@${pg.id}.${pg.region}-postgres.render.com/${pg.databaseName}`,
          psqlCommand: 'redacted',
        });
      }
      if (sub === '/restart') return this.json(202);
    }

    // Key Value
    if (path === '/key-value' && method === 'GET') return this.json(200, this.filter([...this.keyValues.values()], q, 'keyValue'));
    if (path === '/key-value' && method === 'POST') {
      const id = this.id('red');
      const kv = { id, name: body.name, owner: { id: body.ownerId, name: 'Acme' }, plan: body.plan, region: body.region, status: 'available', ipAllowList: body.ipAllowList ?? [], dashboardUrl: `https://dashboard.render.com/r/${id}` };
      this.keyValues.set(id, kv);
      return this.json(201, kv);
    }
    if ((m = path.match(/^\/key-value\/([\w-]+)(\/.*)?$/))) {
      const kv = this.keyValues.get(m[1]!);
      if (!kv) return this.json(404, { message: 'not found' });
      const sub = m[2] ?? '';
      if (!sub && method === 'GET') return this.json(200, kv);
      if (!sub && method === 'DELETE') {
        this.keyValues.delete(kv.id);
        return this.json(204);
      }
      if (!sub && method === 'PATCH') return this.json(200, Object.assign(kv, body));
      if (sub === '/connection-info') {
        return this.json(200, {
          internalConnectionString: `redis://${kv.id}:6379`,
          externalConnectionString: `rediss://${kv.id}:${KV_PASSWORD}@${kv.region}-keyvalue.render.com:6379`,
          cliCommand: 'redacted',
        });
      }
    }

    if (path === '/logs') {
      return this.json(200, {
        hasMore: false,
        nextStartTime: '2026-10-01T00:00:00Z',
        nextEndTime: '2026-10-01T00:00:00Z',
        logs: [
          { id: 'l2', message: 'boom for ops@acme.test', timestamp: '2026-10-01T00:00:02Z', labels: [{ name: 'level', value: 'error' }, { name: 'instance', value: 'srv-1-abc' }, { name: 'resource', value: q.get('resource') }] },
          { id: 'l1', message: 'listening on 8080', timestamp: '2026-10-01T00:00:01Z', labels: [{ name: 'level', value: 'info' }, { name: 'type', value: 'app' }] },
        ],
      });
    }
    return this.json(404, { message: `no fake route for ${method} ${path}` });
  }
}

const target: CloudTarget = {
  id: 't1',
  provider: 'render',
  name: 'Acme Render',
  config: { ownerId: 'tea-acme' },
  credentialRef: 'env://RENDER_API_KEY',
  allowedRegions: ['oregon', 'frankfurt'],
  defaultRegion: 'oregon',
};

function setup(over: Partial<ProviderContext> = {}) {
  const fake = new FakeRender();
  const logs: string[] = [];
  const adapter = new RenderAdapter({ resolveSecret: async () => API_KEY, fetch: fake.fetch });
  const ctx: ProviderContext = { target, region: 'oregon', correlationId: 'c1', log: (_l, m) => logs.push(m), ...over };
  return { fake, adapter, ctx, logs };
}

const webRequest = (over: Partial<ResourceRequest> = {}, spec: Record<string, unknown> = {}): ResourceRequest => ({
  resourceId: 'api',
  serviceKind: 'compute.container-service',
  capability: 'render-web-service',
  name: 'ork-acme-prod-api',
  tags: { 'platform:managed': 'true' },
  spec: { image: 'ghcr.io/acme/api:1.0.0', replicas: 1, cpu: 0.25, memoryMiB: 512, port: 8080, public: true, healthCheckPath: '/health', ...spec },
  dependencyOutputs: {},
  idempotencyKey: 'k1',
  ...over,
});

const pgRequest = (spec: Record<string, unknown> = {}): ResourceRequest => ({
  resourceId: 'database',
  serviceKind: 'database.postgresql',
  capability: 'render-postgres',
  name: 'ork-acme-prod-database',
  tags: {},
  spec: { version: '17', size: 'small', storageGiB: 12, highAvailability: 'none', publicAccess: false, ...spec },
  dependencyOutputs: {},
  idempotencyKey: 'k2',
});

// Render plans nothing ahead (no planResource), so there is no replacing request to check.
runAdapterContract('render', () => {
  const { adapter, ctx } = setup();
  return { adapter, context: ctx, sampleRequest: webRequest(), secrets: [API_KEY] };
});

describe('catalog and plans', () => {
  it('maps every kind with one default and Render prices', () => {
    expect(RENDER_CAPABILITIES.map((c) => c.capability)).toEqual(['render-static-site', 'render-web-service', 'render-private-service', 'render-postgres', 'render-key-value']);
    for (const c of RENDER_CAPABILITIES) expect(c.pricing?.source).toMatch(/^Static Render list prices/);
  });

  it('picks the smallest plan that fits cpu and memory', () => {
    expect(servicePlan(0.25, 512)).toBe('0.5c-512mb');
    expect(servicePlan(0.5, 1024)).toBe('1c-2g');
    expect(servicePlan(2, 6000)).toBe('2c-8g');
    expect(servicePlan(64, 1_000_000)).toBe('12c-96g');
  });
});

describe('validateTarget', () => {
  it('confirms the workspace and reports its name as identity', async () => {
    const { adapter, ctx } = setup();
    const r = await adapter.validateTarget(ctx);
    expect(r.ok).toBe(true);
    expect(r.identity).toBe('Acme');
  });

  it('reports a rejected key without echoing it', async () => {
    const fake = new FakeRender();
    const adapter = new RenderAdapter({ resolveSecret: async () => 'rnd_wrong_key', fetch: fake.fetch });
    const r = await adapter.validateTarget({ target, region: 'oregon', correlationId: 'c' });
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.name === 'API access')?.message).toMatch(/rejected the API key/);
    expect(JSON.stringify(r)).not.toContain('rnd_wrong_key');
  });

  it('rejects unknown workspaces, bad ids and regions', async () => {
    const { adapter, ctx } = setup();
    const missing = await adapter.validateTarget({ ...ctx, target: { ...target, config: { ownerId: 'tea-other' } } });
    expect(missing.checks.find((c) => c.name === 'API access')?.status).toBe('error');
    const bad = await adapter.validateTarget({ ...ctx, target: { ...target, config: { ownerId: 'acme' }, allowedRegions: ['oregon', 'us-east-1'] }, region: 'us-east-1' });
    expect(bad.ok).toBe(false);
    expect(bad.checks.map((c) => [c.name, c.status])).toEqual([
      ['Workspace', 'error'],
      ['Region', 'error'],
      ['API access', 'skipped'],
    ]);
  });
});

describe('web and private services', () => {
  it('creates an image backed web service, then converges and reports unchanged', async () => {
    const { adapter, ctx, fake } = setup();
    const first = await adapter.ensureResource(ctx, webRequest());
    const create = fake.calls.find((c) => c.method === 'POST' && c.path === '/services')!;
    expect(create.body).toMatchObject({
      type: 'web_service',
      name: 'ork-acme-prod-api',
      ownerId: 'tea-acme',
      image: { ownerId: 'tea-acme', imagePath: 'ghcr.io/acme/api:1.0.0' },
      envVars: [{ key: 'PORT', value: '8080' }],
      serviceDetails: { runtime: 'image', plan: '0.5c-512mb', region: 'oregon', numInstances: 1, healthCheckPath: '/health' },
    });
    expect(first).toMatchObject({ unchanged: false, outputs: { kind: 'compute.container-service', url: 'https://ork-acme-prod-api.onrender.com', service_id: first.providerResourceId } });
    expect(first.outputs.dashboard_url).toMatch(/^https:\/\/dashboard\.render\.com\//);

    const again = await adapter.ensureResource(ctx, webRequest());
    expect(again).toMatchObject({ unchanged: true, providerResourceId: first.providerResourceId });

    fake.calls = [];
    const changed = await adapter.ensureResource(ctx, webRequest({}, { image: 'ghcr.io/acme/api:1.1.0', replicas: 3, cpu: 1, memoryMiB: 2048 }));
    expect(changed.unchanged).toBe(false);
    const writes = fake.calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path.replace(first.providerResourceId, 'ID')}`);
    expect(writes).toEqual(['PATCH /services/ID', 'POST /services/ID/deploys', 'POST /services/ID/scale']);
    expect(fake.calls.find((c) => c.method === 'PATCH')!.body).toEqual({ image: { ownerId: 'tea-acme', imagePath: 'ghcr.io/acme/api:1.1.0' }, serviceDetails: { plan: '1c-2g' } });
  });

  it('turns autoscaling on, and falls back to fixed instances when Render refuses it', async () => {
    const { adapter, ctx, fake, logs } = setup();
    await adapter.ensureResource(ctx, webRequest({}, { autoscaling: { minReplicas: 2, maxReplicas: 5, targetCpuPercent: 70 } }));
    const put = fake.calls.find((c) => c.method === 'PUT' && c.path.endsWith('/autoscaling'))!;
    expect(put.body).toMatchObject({ enabled: true, min: 2, max: 5, criteria: { cpu: { enabled: true, percentage: 70 } } });

    const other = setup();
    await other.adapter.ensureResource(other.ctx, webRequest());
    other.fake.failNext = { method: 'PUT', path: /autoscaling$/, status: 402, message: 'Autoscaling requires a Professional workspace' };
    const r = await other.adapter.ensureResource(other.ctx, webRequest({}, { replicas: 2, autoscaling: { minReplicas: 2, maxReplicas: 5, targetCpuPercent: 70 } }));
    expect(r.unchanged).toBe(false);
    expect(other.fake.calls.some((c) => c.path.endsWith('/scale') && c.body.numInstances === 2)).toBe(true);
    expect(other.logs.join('\n')).toMatch(/Autoscaling not accepted/);
    expect(logs.length).toBeGreaterThan(0);
  });

  it('creates a private service when the container is not public', async () => {
    const { adapter, ctx, fake } = setup();
    const r = await adapter.ensureResource(ctx, webRequest({}, { public: false, port: 9000 }));
    expect(fake.calls.find((c) => c.method === 'POST' && c.path === '/services')!.body.type).toBe('private_service');
    expect(r.outputs).toMatchObject({ render_type: 'private_service', host: 'ork-acme-prod-api-x1y2', port: 9000 });
    expect(r.outputs.url).toBeUndefined();
    const state = await adapter.getResource(ctx, webRequest({ providerResourceId: r.providerResourceId } as never));
    expect(state.outputs.port).toBe(9000);
  });

  it('refuses to change a service type in place', async () => {
    const { adapter, ctx } = setup();
    await adapter.ensureResource(ctx, webRequest());
    await expect(adapter.ensureResource(ctx, webRequest({}, { public: false }))).rejects.toMatchObject({ code: 'RENDER_SERVICE_TYPE_CHANGE', failureClass: 'RESOURCE_CONFLICT' });
  });
});

describe('static sites', () => {
  const site = (spec: Record<string, unknown> = {}): ResourceRequest => ({
    resourceId: 'web',
    serviceKind: 'web.frontend',
    capability: 'render-static-site',
    name: 'ork-acme-prod-web',
    tags: {},
    spec: {
      source: { repository: 'acme/site', branch: 'main', rootDirectory: 'apps/web', gitProvider: 'github' },
      installCommand: 'pnpm install',
      buildCommand: 'pnpm build',
      outputDirectory: 'dist',
      nodeVersion: '22',
      environment: { PUBLIC_API: 'https://api.acme.test' },
      domains: ['www.acme.test'],
      previewDeployments: false,
      ...spec,
    },
    dependencyOutputs: { api: { kind: 'compute.container-service', url: 'https://ork-acme-prod-api.onrender.com' } },
    idempotencyKey: 'k3',
  });

  it('creates the site from the repository with domains, previews and environment', async () => {
    const { adapter, ctx, fake } = setup();
    const r = await adapter.ensureResource(ctx, site());
    const body = fake.calls.find((c) => c.method === 'POST' && c.path === '/services')!.body;
    expect(body).toMatchObject({
      type: 'static_site',
      repo: 'https://github.com/acme/site',
      branch: 'main',
      rootDir: 'apps/web',
      autoDeploy: 'yes',
      serviceDetails: { buildCommand: 'pnpm install && pnpm build', publishPath: 'dist', previews: { generation: 'off' } },
    });
    expect(Object.fromEntries(body.envVars.map((e: Json) => [e.key, e.value]))).toEqual({
      API_URL: 'https://ork-acme-prod-api.onrender.com',
      NODE_VERSION: '22',
      PUBLIC_API: 'https://api.acme.test',
    });
    expect(fake.calls.some((c) => c.method === 'POST' && c.path.endsWith('/custom-domains') && c.body.name === 'www.acme.test')).toBe(true);
    expect(r.outputs).toMatchObject({ kind: 'web.frontend', url: 'https://www.acme.test' });
    expect((await adapter.ensureResource(ctx, site())).unchanged).toBe(true);

    const changed = await adapter.ensureResource(ctx, site({ previewDeployments: true }));
    expect(changed.unchanged).toBe(false);
    expect(fake.calls.filter((c) => c.method === 'PATCH').at(-1)!.body.serviceDetails.previews).toEqual({ generation: 'automatic' });
  });

  it('offers redeploy without restart or scale', () => {
    const { adapter } = setup();
    expect(adapter.actions('render-static-site').map((a) => a.name)).toEqual(['redeploy', 'rollback', 'suspend', 'resume']);
  });
});

describe('dependency wiring', () => {
  it('uses the internal connection string for a Render database in the same workspace and region', async () => {
    const { adapter, ctx, fake, logs } = setup();
    const db = await adapter.ensureResource(ctx, pgRequest());
    const r = await adapter.ensureResource(ctx, webRequest({ dependencyOutputs: { database: db.outputs } }));
    const env = Object.fromEntries(fake.calls.find((c) => c.method === 'POST' && c.path === '/services')!.body.envVars.map((e: Json) => [e.key, e.value]));
    expect(env.DATABASE_URL).toBe(`postgresql://database_user:${PG_PASSWORD}@${db.providerResourceId}/database`);
    expect(env.DATABASE_HOST).toBe(db.providerResourceId);
    expect(env.DATABASE_PASSWORD).toBe(PG_PASSWORD);
    expect(env.DATABASE_INTERNAL_URL).toBeUndefined();
    const visible = JSON.stringify([db, r, logs]);
    expect(visible).not.toContain(PG_PASSWORD);
  });

  it('reads credentials of other providers through dependencySecret and keeps them out of errors', async () => {
    const secret = 'sb-db-password-abcdef';
    const { adapter, ctx, fake, logs } = setup({ dependencySecret: async (id) => ({ url: `postgresql://u:${secret}@db.example.test:5432/app`, password: secret, id }) });
    const deps = { orders: { kind: 'database.postgresql', host: 'db.example.test', port: 5432, secret_ref: 'supabase-db://abc' } };
    fake.failNext = { method: 'POST', path: /^\/services$/, status: 400, message: `invalid value ${secret} for ORDERS_PASSWORD` };
    const err = await adapter.ensureResource(ctx, webRequest({ dependencyOutputs: deps })).catch((e: Error) => e);
    expect(err).toMatchObject({ code: 'RENDER_HTTP_400', failureClass: 'VALIDATION_ERROR' });
    expect((err as Error).message).not.toContain(secret);

    const r = await adapter.ensureResource(ctx, webRequest({ dependencyOutputs: deps }));
    const env = Object.fromEntries(fake.calls.filter((c) => c.method === 'POST' && c.path === '/services').at(-1)!.body.envVars.map((e: Json) => [e.key, e.value]));
    expect(env).toMatchObject({ ORDERS_HOST: 'db.example.test', ORDERS_PORT: '5432', ORDERS_PASSWORD: secret });
    expect(JSON.stringify([r, logs])).not.toContain(secret);
  });

  it('warns, without values, when no secret reader is available', async () => {
    const { adapter, ctx, logs } = setup();
    await adapter.ensureResource(ctx, webRequest({ dependencyOutputs: { cache: { kind: 'cache.redis', host: 'h', port: 6379, secret_ref: 'aws-sm://x' } } }));
    expect(logs.join('\n')).toMatch(/Credentials not wired for: cache/);
  });
});

describe('Postgres and Key Value', () => {
  it('creates Postgres private by default, sized by plan, with a secret reference', async () => {
    const { adapter, ctx, fake, logs } = setup();
    const r = await adapter.ensureResource(ctx, pgRequest({ highAvailability: 'zone-redundant' }));
    expect(fake.calls.find((c) => c.method === 'POST' && c.path === '/postgres')!.body).toMatchObject({
      plan: '0.5c-1g',
      version: '17',
      region: 'oregon',
      diskSizeGB: 15,
      enableHighAvailability: false,
      ipAllowList: [],
      databaseName: 'database',
      databaseUser: 'database_user',
    });
    expect(logs.join('\n')).toMatch(/High availability needs at least 1 CPU/);
    expect(r.outputs).toMatchObject({
      kind: 'database.postgresql',
      host: `${r.providerResourceId}.oregon-postgres.render.com`,
      port: 5432,
      database: 'database',
      username: 'database_user',
      secret_ref: `render-postgres://${r.providerResourceId}`,
    });
    expect(JSON.stringify(r)).not.toContain(PG_PASSWORD);
  });

  it('enables high availability on plans with a full CPU and converges disk and access', async () => {
    const { adapter, ctx, fake } = setup();
    const created = await adapter.ensureResource(ctx, pgRequest({ size: 'medium', highAvailability: 'zone-redundant' }));
    expect(fake.calls.find((c) => c.method === 'POST' && c.path === '/postgres')!.body).toMatchObject({ plan: '1c-4g', enableHighAvailability: true });
    expect((await adapter.ensureResource(ctx, pgRequest({ size: 'medium', highAvailability: 'zone-redundant' }))).unchanged).toBe(true);
    const grown = await adapter.ensureResource(ctx, pgRequest({ size: 'medium', highAvailability: 'zone-redundant', storageGiB: 40, publicAccess: true }));
    expect(grown.unchanged).toBe(false);
    expect(fake.calls.find((c) => c.method === 'PATCH')!.body).toEqual({ diskSizeGB: 40, ipAllowList: [{ cidrBlock: '0.0.0.0/0', description: 'everywhere' }] });
    // Shrinking storage is not possible on Render, so a smaller request changes nothing.
    expect((await adapter.ensureResource(ctx, pgRequest({ size: 'medium', highAvailability: 'zone-redundant', storageGiB: 10, publicAccess: true }))).unchanged).toBe(true);
    expect(created.providerResourceId).toMatch(/^dpg-/);
  });

  it('creates Key Value and publishes host and secret reference', async () => {
    const { adapter, ctx, fake } = setup();
    const req: ResourceRequest = { ...pgRequest(), resourceId: 'cache', serviceKind: 'cache.redis', capability: 'render-key-value', name: 'ork-acme-prod-cache', spec: { size: 'small', replicas: 0 } };
    const r = await adapter.ensureResource(ctx, req);
    expect(fake.calls.find((c) => c.method === 'POST' && c.path === '/key-value')!.body).toEqual({ name: 'ork-acme-prod-cache', ownerId: 'tea-acme', plan: '1g', region: 'oregon', ipAllowList: [] });
    expect(r.outputs).toMatchObject({ kind: 'cache.redis', host: 'oregon-keyvalue.render.com', internal_host: r.providerResourceId, port: 6379, secret_ref: `render-kv://${r.providerResourceId}` });
    expect((await adapter.ensureResource(ctx, req)).unchanged).toBe(true);
  });

  it('readSecret returns connection fields for both references', async () => {
    const { adapter, ctx } = setup();
    const pg = await adapter.ensureResource(ctx, pgRequest());
    expect(await adapter.readSecret(ctx, String(pg.outputs.secret_ref))).toEqual({
      url: `postgresql://database_user:${PG_PASSWORD}@${pg.providerResourceId}.oregon-postgres.render.com/database`,
      internalUrl: `postgresql://database_user:${PG_PASSWORD}@${pg.providerResourceId}/database`,
      username: 'database_user',
      password: PG_PASSWORD,
      host: `${pg.providerResourceId}.oregon-postgres.render.com`,
      port: '5432',
      database: 'database',
    });
    const kv = await adapter.ensureResource(ctx, { ...pgRequest(), capability: 'render-key-value', serviceKind: 'cache.redis', name: 'kv', spec: { size: 'micro' } });
    expect(await adapter.readSecret(ctx, String(kv.outputs.secret_ref))).toMatchObject({ password: KV_PASSWORD, host: 'oregon-keyvalue.render.com', port: '6379', internalUrl: `redis://${kv.providerResourceId}:6379` });
    await expect(adapter.readSecret(ctx, 'aws-sm://nope')).rejects.toMatchObject({ code: 'RENDER_SECRET_REF_UNKNOWN' });
  });
});

describe('health, deployments and logs', () => {
  async function service() {
    const s = setup();
    const r = await s.adapter.ensureResource(s.ctx, webRequest());
    const svc = s.fake.services.get(r.providerResourceId)!;
    return { ...s, svc, ident: { ...webRequest(), providerResourceId: r.providerResourceId } };
  }

  it('maps deploy status and the HTTP probe to health', async () => {
    const { adapter, ctx, fake, svc, ident } = await service();
    expect((await adapter.checkHealth(ctx, ident)).state).toBe('HEALTHY');
    fake.siteStatus = 503;
    expect((await adapter.checkHealth(ctx, ident)).state).toBe('UNHEALTHY');
    fake.siteStatus = 200;
    svc.deploys[0].status = 'build_in_progress';
    expect((await adapter.checkHealth(ctx, ident)).state).toBe('DEGRADED');
    svc.deploys[0].status = 'build_failed';
    expect(await adapter.checkHealth(ctx, ident)).toMatchObject({ state: 'UNHEALTHY', message: expect.stringMatching(/build failed/) });
    svc.suspended = 'suspended';
    svc.suspenders = ['user'];
    expect((await adapter.checkHealth(ctx, ident)).state).toBe('MAINTENANCE');
    svc.suspenders = ['billing'];
    expect((await adapter.checkHealth(ctx, ident)).state).toBe('UNHEALTHY');
  });

  it('maps datastore status to health', async () => {
    const { adapter, ctx, fake } = setup();
    const pg = await adapter.ensureResource(ctx, pgRequest());
    const ident = { ...pgRequest(), providerResourceId: pg.providerResourceId };
    expect((await adapter.checkHealth(ctx, ident)).state).toBe('DEGRADED');
    fake.postgres.get(pg.providerResourceId)!.status = 'available';
    expect((await adapter.checkHealth(ctx, ident)).state).toBe('HEALTHY');
  });

  it('lists deploys as provider deployments', async () => {
    const { adapter, ctx, ident } = await service();
    await adapter.runAction(ctx, ident, { action: 'redeploy', params: { commitId: 'beef' } });
    const list = await adapter.listDeployments(ctx, ident, 10);
    expect(list.map((d) => [d.status, d.revision])).toEqual([
      ['building', 'beef'],
      ['superseded', 'c0ffee'],
    ]);
  });

  it('returns redacted logs oldest first', async () => {
    const { adapter, ctx, fake, ident } = await service();
    const lines = await adapter.getLogs(ctx, ident, 50);
    expect(lines.map((l) => l.level)).toEqual(['info', 'error']);
    expect(lines[1]!.message).toBe('boom for <email>');
    expect(lines[1]!.attributes).toEqual({ instance: 'srv-1-abc' });
    const call = fake.calls.find((c) => c.path === '/logs')!;
    expect(call.query.get('ownerId')).toBe('tea-acme');
    expect(call.query.getAll('resource')).toEqual([ident.providerResourceId]);
  });

  it('treats a missing resource as gone', async () => {
    const { adapter, ctx } = setup();
    const ident = { ...webRequest(), providerResourceId: 'srv-gone' };
    expect(await adapter.probeExists(ctx, ident)).toBe(false);
    await expect(adapter.deleteResource(ctx, ident)).resolves.toBeUndefined();
  });
});

describe('actions', () => {
  it('runs service actions with Render payloads', async () => {
    const { adapter, ctx, fake } = setup();
    const r = await adapter.ensureResource(ctx, webRequest());
    const ident = { ...webRequest(), providerResourceId: r.providerResourceId };
    const redeploy = await adapter.runAction(ctx, ident, { action: 'redeploy', params: { clearCache: true, imageUrl: 'ghcr.io/acme/api:1.2.0' } });
    expect(redeploy).toMatchObject({ status: 'started', reference: expect.stringMatching(/^dep-/) });
    expect(fake.calls.filter((c) => c.path.endsWith('/deploys') && c.method === 'POST').at(-1)!.body).toEqual({ clearCache: 'clear', imageUrl: 'ghcr.io/acme/api:1.2.0' });

    const rollback = await adapter.runAction(ctx, ident, { action: 'rollback', params: { deployId: 'dep-old' } });
    expect(rollback.reference).toMatch(/^dep-/);
    expect(fake.calls.at(-1)!.body).toEqual({ deployId: 'dep-old' });

    await adapter.runAction(ctx, ident, { action: 'scale', params: { numInstances: 3 } });
    expect(fake.services.get(r.providerResourceId)!.serviceDetails.numInstances).toBe(3);
    await adapter.runAction(ctx, ident, { action: 'suspend', params: {} });
    expect(fake.services.get(r.providerResourceId)!.suspended).toBe('suspended');
    await adapter.runAction(ctx, ident, { action: 'resume', params: {} });
    expect((await adapter.runAction(ctx, ident, { action: 'restart', params: {} })).status).toBe('started');
  });

  it('validates action names and parameters before calling Render', async () => {
    const { adapter, ctx, fake } = setup();
    const ident = { ...webRequest(), providerResourceId: 'srv-x' };
    await expect(adapter.runAction(ctx, ident, { action: 'rollback', params: {} })).rejects.toMatchObject({ code: 'RENDER_ACTION_PARAMS' });
    await expect(adapter.runAction(ctx, ident, { action: 'scale', params: { numInstances: 0 } })).rejects.toMatchObject({ code: 'RENDER_ACTION_PARAMS' });
    await expect(adapter.runAction(ctx, ident, { action: 'redeploy', params: { clearCache: 'yes' } })).rejects.toMatchObject({ code: 'RENDER_ACTION_PARAMS' });
    await expect(adapter.runAction(ctx, ident, { action: 'purge', params: {} })).rejects.toMatchObject({ code: 'RENDER_ACTION_UNKNOWN' });
    expect(fake.calls).toHaveLength(0);
  });

  it('restarts Postgres', async () => {
    const { adapter, ctx, fake } = setup();
    const pg = await adapter.ensureResource(ctx, pgRequest());
    expect(adapter.actions('render-postgres').map((a) => a.name)).toEqual(['restart']);
    await adapter.runAction(ctx, { ...pgRequest(), providerResourceId: pg.providerResourceId }, { action: 'restart', params: {} });
    expect(fake.calls.at(-1)).toMatchObject({ method: 'POST', path: `/postgres/${pg.providerResourceId}/restart` });
  });
});
