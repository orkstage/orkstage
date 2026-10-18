// SPDX-License-Identifier: AGPL-3.0-only
import type { CloudTarget, ProviderContext, ResourceIdentifier, ResourceRequest } from '@orkstage/cloud-core';
import { runAdapterContract } from '@orkstage/cloud-core/testing';
import { stateKeyFor, type StateStore } from '@orkstage/cloud-tofu';
import { FakeTofu, MemoryStateStore } from '@orkstage/cloud-tofu/testing';
import type { TofuRunner } from '@orkstage/iac';
import { describe, expect, it, vi } from 'vitest';
import { VultrAdapter, type VultrAdapterOptions } from './adapter.js';
import type { VultrCredentials } from './api.js';
import { VULTR_CAPABILITIES } from './catalog.js';
import { vultrConfigChecks } from './config.js';
import { databaseState } from './health.js';
import { databaseNodes, instancePlan, pickDatabasePlan, pickObjectStorage } from './sizing.js';
import { singleRoute, vultrModuleCall, vultrTags } from './stacks.js';

/** Same adapter with state kept in memory instead of Object Storage (the S3 SDK does not use fetch). */
class TestAdapter extends VultrAdapter {
  constructor(
    opts: VultrAdapterOptions,
    readonly store = new MemoryStateStore(),
  ) {
    super(opts);
  }
  protected override stateStore(_ctx: ProviderContext, _creds: VultrCredentials): StateStore {
    return this.store;
  }
}

const SECRET = JSON.stringify({ apiKey: 'vk-secret', stateAccessKeyId: 'AKSTATE', stateSecretAccessKey: 'sk-state' });
const target: CloudTarget = {
  id: 't1',
  provider: 'vultr',
  name: 'Vultr',
  config: { stateBucket: 'orkstage-state', stateEndpoint: 'ewr1.vultrobjects.com' },
  credentialRef: 'env://VULTR',
  allowedRegions: ['ewr', 'sao'],
  defaultRegion: 'ewr',
};
const ctx: ProviderContext = { target, region: 'ewr', correlationId: 'c1' };
const network = { kind: 'network', network_id: 'vpc-1', cidr: '10.20.0.0/20', region: 'ewr' };

const request = (over: Partial<ResourceRequest>): ResourceRequest => ({
  resourceId: 'api',
  serviceKind: 'compute.container-service',
  capability: 'instance-docker',
  name: 'ork-acme-prod-api',
  tags: { 'platform:managed': 'true', 'platform:environment': 'production' },
  spec: { image: 'ghcr.io/acme/api@sha256:abc', cpu: 0.5, memoryMiB: 1024, replicas: 2, port: 8080, public: true },
  dependencyOutputs: { network },
  idempotencyKey: 'k',
  ...over,
});

type Route = { method: string; url: string; body?: unknown };

/** Fake Vultr API: answers by path, records every call. */
function fakeVultr(routes: Record<string, unknown | ((r: Route) => unknown)>) {
  const calls: Route[] = [];
  const f = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const call = { method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBe('Bearer vk-secret');
    const path = url.replace('https://api.vultr.com/v2', '');
    const key = Object.keys(routes).find((k) => k === `${method} ${path}` || k === path);
    if (!key) return new Response('{"error":"not found"}', { status: 404 });
    const value = routes[key];
    const body = typeof value === 'function' ? (value as (r: Route) => unknown)(call) : value;
    if (typeof body === 'number') return new Response('', { status: body });
    return body === undefined ? new Response(null, { status: 204 }) : new Response(JSON.stringify(body), { status: 200 });
  });
  return { fetch: f as unknown as typeof fetch, calls };
}

function fakeRunner(outputs: Record<string, unknown>) {
  return {
    apply: vi.fn().mockResolvedValue({ outputs: { all: outputs }, changes: { add: 1, change: 0, remove: 0 } }),
    plan: vi.fn().mockResolvedValue({ changes: { add: 0, change: 0, remove: 2 }, actions: [{ address: 'module.resource.vultr_instance.this[0]', action: 'replace' }] }),
    drift: vi.fn().mockResolvedValue([]),
    destroy: vi.fn().mockResolvedValue(undefined),
  } as unknown as TofuRunner;
}

const ident = (over: Partial<ResourceIdentifier>): ResourceIdentifier => ({ resourceId: 'api', serviceKind: 'compute.container-service', capability: 'instance-docker', name: 'ork-acme-prod-api', ...over });

describe('catalog and configuration', () => {
  it('has one default per kind and the agreed capability ids', () => {
    expect(VULTR_CAPABILITIES.map((c) => `${c.serviceKind}:${c.capability}`)).toEqual([
      'network:vpc',
      'compute.container-service:instance-docker',
      'database.postgresql:managed-postgres',
      'cache.redis:managed-valkey',
      'object-storage:object-storage',
      'ingress:load-balancer',
    ]);
    expect(VULTR_CAPABILITIES.every((c) => c.isDefault && c.pricing?.source.startsWith('Static Vultr list prices'))).toBe(true);
    expect(VULTR_CAPABILITIES.find((c) => c.capability === 'load-balancer')!.regions).not.toContain('sao');
  });

  it('checks state bucket, endpoint and region ids', () => {
    expect(vultrConfigChecks(target).every((c) => c.status === 'ok')).toBe(true);
    const bad = vultrConfigChecks({ ...target, config: { stateBucket: 'X', stateEndpoint: 'https://ewr1.vultrobjects.com' }, allowedRegions: ['us-east-1'] });
    expect(bad.map((c) => [c.name, c.status])).toEqual([
      ['State bucket', 'error'],
      ['State endpoint', 'error'],
      ['Regions', 'error'],
    ]);
  });
});

describe('validateTarget', () => {
  it('reports the account name as identity', async () => {
    const api = fakeVultr({ '/account': { account: { name: 'Acme Ltda', email: 'ops@acme.test' } } });
    const a = new TestAdapter({ resolveSecret: async () => SECRET, fetch: api.fetch });
    const r = await a.validateTarget(ctx);
    expect(r).toMatchObject({ ok: true, identity: 'Acme Ltda' });
    expect(JSON.stringify(r)).not.toContain('ops@acme.test');
  });

  it('explains a rejected key without echoing it', async () => {
    const api = fakeVultr({ '/account': 401 });
    const a = new TestAdapter({ resolveSecret: async () => SECRET, fetch: api.fetch });
    const r = await a.validateTarget(ctx);
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.name === 'Account access')).toMatchObject({ status: 'error' });
    expect(JSON.stringify(r)).not.toContain('vk-secret');
  });

  it('requires all credential fields', async () => {
    const a = new TestAdapter({ resolveSecret: async () => '{"apiKey":"x"}' });
    const r = await a.validateTarget(ctx);
    expect(r.checks.find((c) => c.name === 'Credentials')?.message).toMatch(/stateAccessKeyId, stateSecretAccessKey/);
  });
});

describe('root configuration', () => {
  it('uses the Object Storage backend and passes credentials only as environment', async () => {
    const runner = fakeRunner({ kind: 'network', network_id: 'vpc-9', cidr: '10.1.0.0/20' });
    const a = new TestAdapter({ resolveSecret: async () => SECRET, runner, fetch: fakeVultr({}).fetch });
    const result = await a.ensureResource(ctx, request({ resourceId: 'network', serviceKind: 'network', capability: 'vpc', name: 'ork-acme-prod-net', spec: { availabilityZones: 2 }, dependencyOutputs: {} }));
    expect(result.providerResourceId).toBe('vpc-9');
    const stack = vi.mocked(runner.apply).mock.calls[0]![0];
    expect(stack.env).toEqual({ VULTR_API_KEY: 'vk-secret', AWS_ACCESS_KEY_ID: 'AKSTATE', AWS_SECRET_ACCESS_KEY: 'sk-state' });
    const config = stack.config as { terraform: { backend: { s3: Record<string, unknown> }; required_providers: Record<string, unknown> }; module: { resource: Record<string, unknown> } };
    expect(config.terraform.backend.s3).toMatchObject({ bucket: 'orkstage-state', key: stateKeyFor('ork-acme-prod-net'), endpoints: { s3: 'https://ewr1.vultrobjects.com' }, use_path_style: true, use_lockfile: false });
    expect(config.terraform.required_providers).toEqual({ vultr: { source: 'vultr/vultr', version: '~> 2.30' } });
    expect(config.module.resource).toMatchObject({ source: '/modules/vultr/network', region: 'ewr', v4_subnet_mask: 20 });
    expect(JSON.stringify(config)).not.toMatch(/vk-secret|sk-state|AKSTATE/);
  });
});

describe('module inputs', () => {
  it('sizes instances from cpu and memory and wires dependencies', () => {
    const { module, inputs } = vultrModuleCall(ctx, request({
      dependencyOutputs: {
        network,
        ingress: { kind: 'ingress', lb_id: 'lb-1', service: 'api', url: 'http://203.0.113.5/' },
        'orders-db': { kind: 'database.postgresql', host: 'vpc-db.vultrdb.com', port: 16751, secret_ref: 'vultr-db://db-1' },
        files: { kind: 'object-storage', bucket: 'b1', endpoint: 'https://ewr1.vultrobjects.com', secret_ref: 'vultr-objstore://os-1' },
        cache: { kind: 'cache.redis', host: 'cache.local', port: 6379, secret_ref: 'kv://elsewhere' },
      },
    }));
    expect(module).toBe('container-service');
    expect(inputs).toMatchObject({
      plan: 'vc2-1c-1gb',
      replicas: 2,
      vpc_id: 'vpc-1',
      vpc_cidr: '10.20.0.0/20',
      lb_id: 'lb-1',
      ingress_url: 'http://203.0.113.5/',
      inject_credentials: true,
      database_refs: { ORDERS_DB: 'db-1' },
      object_storage_refs: { FILES: 'os-1' },
      environment: { ORDERS_DB_HOST: 'vpc-db.vultrdb.com', ORDERS_DB_PORT: '16751', FILES_BUCKET: 'b1', CACHE_CREDENTIALS_REF: 'kv://elsewhere' },
      tags: ['platform_managed=true', 'platform_environment=production'],
    });
  });

  it('keeps credentials out of user data when asked', () => {
    const { inputs } = vultrModuleCall(ctx, request({
      spec: { image: 'x', providerOverrides: { vultr: { injectCredentials: false } } },
      dependencyOutputs: { network, db: { kind: 'database.postgresql', secret_ref: 'vultr-db://db-1' } },
    }));
    expect(inputs).toMatchObject({ inject_credentials: false, database_refs: {}, environment: { DB_CREDENTIALS_REF: 'vultr-db://db-1' } });
  });

  it('runs the autoscaling minimum as fixed replicas and says so', () => {
    const log = vi.fn();
    const { inputs } = vultrModuleCall({ ...ctx, log }, request({ spec: { image: 'x', replicas: 1, autoscaling: { minReplicas: 3, maxReplicas: 6, targetCpuPercent: 60 } } }));
    expect(inputs.replicas).toBe(3);
    expect(log).toHaveBeenCalledWith('warn', expect.stringMatching(/do not autoscale/));
  });

  it('accepts one service per load balancer, without paths', () => {
    expect(singleRoute({ routes: [{ service: 'api', pathPrefix: '/', port: 8080, healthCheckPath: '/health' }] })).toEqual({ service: 'api', port: 8080, healthPath: '/health' });
    expect(() => singleRoute({ routes: [{ service: 'api', pathPrefix: '/', port: 8080 }, { service: 'web', pathPrefix: '/', port: 3000 }] })).toThrow(/one service only/);
    expect(() => singleRoute({ routes: [{ service: 'api', pathPrefix: '/v1', port: 8080 }] })).toThrow(/do not route by path/);
    expect(() => singleRoute({ routes: [{ service: 'api' }] })).toThrow(/declares no port/);
    const { inputs } = vultrModuleCall(ctx, request({ resourceId: 'edge', serviceKind: 'ingress', capability: 'load-balancer', spec: { tls: false, routes: [{ service: 'api', port: 8080 }] } }));
    expect(inputs).toMatchObject({ vpc_id: 'vpc-1', service: 'api', port: 8080, health_path: '/', auto_ssl_domain: '' });
  });

  it('needs the looked up plan for databases and rejects unknown capabilities', () => {
    const db = request({ resourceId: 'db', serviceKind: 'database.postgresql', capability: 'managed-postgres', spec: { size: 'small', version: '17' } });
    expect(() => vultrModuleCall(ctx, db)).toThrow(/looked up from the Vultr API/);
    const { inputs } = vultrModuleCall(ctx, { ...db, spec: { ...db.spec, vultrResolved: { plan: 'p1', sizeKey: 'small/1' } } });
    expect(inputs).toMatchObject({ plan: 'p1', engine_version: '17', public_access: false, vpc_cidr: '10.20.0.0/20' });
    expect(() => vultrModuleCall(ctx, request({ capability: 'vke-deployment' }))).toThrow(/not implemented/);
  });

  it('builds safe tags', () => {
    expect(vultrTags({ 'platform:tenant': 'acme corp' })).toEqual(['platform_tenant=acme_corp']);
  });
});

describe('sizing', () => {
  it('picks the cheapest instance plan that fits', () => {
    expect(instancePlan(0.25, 512)).toBe('vc2-1c-1gb');
    expect(instancePlan(2, 2048)).toBe('vc2-2c-2gb');
    expect(instancePlan(1, 3000)).toBe('vc2-2c-4gb');
    expect(() => instancePlan(32, 1024)).toThrow(/No Vultr cloud compute plan/);
  });

  it('picks database plans by engine, region, memory and nodes', () => {
    const plan = (id: string, ram: number, nodes: number, cost: number, engines: Record<string, boolean>, locations = ['ewr']) => ({ id, ram, number_of_nodes: nodes, monthly_cost: cost, supported_engines: engines, locations, type: 'x', vcpu_count: 1, disk: 25 });
    const plans = [
      plan('hobby', 1024, 1, 15, { pg: true }),
      plan('startup', 2048, 1, 30, { pg: true, valkey: true }),
      plan('business', 2048, 2, 50, { pg: true }),
      plan('far', 2048, 1, 10, { pg: true }, ['fra']),
    ];
    expect(pickDatabasePlan(plans, 'pg', 'ewr', 1024, 1)?.id).toBe('hobby');
    expect(pickDatabasePlan(plans, 'pg', 'ewr', 2048, 2)?.id).toBe('business');
    expect(pickDatabasePlan(plans, 'valkey', 'ewr', 1024, 1)?.id).toBe('startup');
    expect(pickDatabasePlan(plans, 'pg', 'sao', 1024, 1)).toBeUndefined();
    expect(databaseNodes('database.postgresql', { highAvailability: 'same-zone' })).toBe(2);
    expect(databaseNodes('cache.redis', { replicas: 5 })).toBe(3);
  });

  it('picks the cheapest object storage tier in the region', () => {
    const clusters = [
      { id: 2, region: 'ewr', hostname: 'ewr1.vultrobjects.com', deploy: 'yes' },
      { id: 9, region: 'ewr', hostname: 'ewr2.vultrobjects.com', deploy: 'yes' },
      { id: 4, region: 'sgp', hostname: 'sgp1.vultrobjects.com', deploy: 'yes' },
    ];
    const tiers = new Map([
      [2, [{ id: 1, slug: 'legacy', price: 18 }]],
      [9, [{ id: 2, slug: 'standard', price: 18 }, { id: 3, slug: 'premium', price: 36 }]],
    ]);
    expect(pickObjectStorage(clusters, tiers, 'ewr')).toEqual({ clusterId: 9, tierId: 2, hostname: 'ewr2.vultrobjects.com' });
    expect(pickObjectStorage(clusters, tiers, 'sao')).toBeUndefined();
  });
});

describe('lookups before apply', () => {
  it('resolves the database plan from the API, then keeps the recorded plan while the size is unchanged', async () => {
    const api = fakeVultr({
      '/databases/plans?engine=pg&region=ewr': { plans: [{ id: 'vultr-dbaas-startup-cc-1-55-2', ram: 2048, number_of_nodes: 1, monthly_cost: 30, supported_engines: { pg: true }, locations: ['ewr'] }] },
    });
    const runner = fakeRunner({ kind: 'database.postgresql', id: 'db-1', plan: 'vultr-dbaas-startup-cc-1-55-2', size_key: 'small/1', secret_ref: 'vultr-db://db-1' });
    const a = new TestAdapter({ resolveSecret: async () => SECRET, runner, fetch: api.fetch });
    const db = request({ resourceId: 'db', serviceKind: 'database.postgresql', capability: 'managed-postgres', name: 'ork-acme-prod-db', spec: { size: 'small', version: '17', highAvailability: 'none' } });
    const first = await a.ensureResource(ctx, db);
    expect(first.providerResourceId).toBe('db-1');
    expect((vi.mocked(runner.apply).mock.calls[0]![0].config as { module: { resource: { plan: string } } }).module.resource.plan).toBe('vultr-dbaas-startup-cc-1-55-2');
    a.store.objects.set(stateKeyFor('ork-acme-prod-db'), JSON.stringify({ resources: [{ mode: 'managed' }], outputs: { all: { value: first.outputs } } }));
    api.calls.length = 0;
    await a.ensureResource(ctx, db);
    expect(api.calls).toEqual([]);
  });

  it('fails clearly when no plan fits', async () => {
    const api = fakeVultr({ '/databases/plans?engine=valkey&region=ewr': { plans: [] } });
    const a = new TestAdapter({ resolveSecret: async () => SECRET, runner: fakeRunner({}), fetch: api.fetch });
    await expect(a.ensureResource(ctx, request({ serviceKind: 'cache.redis', capability: 'managed-valkey', spec: { size: 'micro', replicas: 0 } }))).rejects.toMatchObject({ code: 'VULTR_NO_DATABASE_PLAN', failureClass: 'VALIDATION_ERROR' });
  });

  it('resolves the object storage cluster and tier', async () => {
    const api = fakeVultr({
      '/object-storage/clusters': { clusters: [{ id: 9, region: 'ewr', hostname: 'ewr2.vultrobjects.com', deploy: 'yes' }] },
      '/object-storage/clusters/9/tiers': { tiers: [{ id: 5, slug: 'tier_standard', price: 18 }] },
    });
    const runner = fakeRunner({ kind: 'object-storage', id: 'os-1', bucket: 'b' });
    const a = new TestAdapter({ resolveSecret: async () => SECRET, runner, fetch: api.fetch });
    await a.ensureResource(ctx, request({ serviceKind: 'object-storage', capability: 'object-storage', spec: { versioning: true } }));
    expect((vi.mocked(runner.apply).mock.calls[0]![0].config as { module: { resource: Record<string, unknown> } }).module.resource).toMatchObject({ cluster_id: 9, tier_id: 5, versioning: true });
  });
});

describe('load balancer attachment', () => {
  it('replaces the old instances with the new ones and leaves others alone', async () => {
    let instances = ['other', 'old-1'];
    const api = fakeVultr({
      'GET /load-balancers/lb-1': () => ({ load_balancer: { id: 'lb-1', status: 'active', instances } }),
      'PATCH /load-balancers/lb-1': (r: Route) => {
        instances = (r.body as { instances: string[] }).instances;
        return undefined;
      },
    });
    const runner = fakeRunner({ kind: 'compute.container-service', service_id: 'ork-acme-prod-api', instance_ids: 'new-1,new-2', lb_id: 'lb-1' });
    const a = new TestAdapter({ resolveSecret: async () => SECRET, runner, fetch: api.fetch });
    a.store.objects.set(stateKeyFor('ork-acme-prod-api'), JSON.stringify({ resources: [{ mode: 'managed' }], outputs: { all: { value: { instance_ids: 'old-1', lb_id: 'lb-1' } } } }));
    await a.ensureResource(ctx, request({ dependencyOutputs: { network, ingress: { kind: 'ingress', lb_id: 'lb-1', service: 'api', url: 'http://lb/' } } }));
    expect(instances).toEqual(['other', 'new-1', 'new-2']);

    await a.deleteResource(ctx, ident({ outputs: { instance_ids: 'new-1,new-2', lb_id: 'lb-1' } }));
    expect(instances).toEqual(['other']);
  });

  it('does not patch when nothing changes', async () => {
    const api = fakeVultr({ 'GET /load-balancers/lb-1': { load_balancer: { id: 'lb-1', status: 'active', instances: ['i-1'] } } });
    const a = new TestAdapter({ resolveSecret: async () => SECRET, runner: fakeRunner({ kind: 'compute.container-service', instance_ids: 'i-1', lb_id: 'lb-1' }), fetch: api.fetch });
    await a.ensureResource(ctx, request({}));
    expect(api.calls.filter((c) => c.method === 'PATCH')).toEqual([]);
  });
});

describe('health, probes, secrets and actions', () => {
  it('reports instance, database and load balancer health', async () => {
    const api = fakeVultr({
      '/instances/i-1': { instance: { id: 'i-1', power_status: 'running', server_status: 'ok' } },
      '/instances/i-2': { instance: { id: 'i-2', power_status: 'stopped', server_status: 'none' } },
      '/databases/db-1': { database: { id: 'db-1', status: 'Running' } },
      '/load-balancers/lb-1': { load_balancer: { id: 'lb-1', status: 'active', instances: ['i-1'] } },
    });
    const f = vi.fn(async (input: string | URL | Request, init?: RequestInit) => (String(input).startsWith('http://203.0.113.5') ? new Response('ok', { status: 200 }) : api.fetch(input, init)));
    const a = new TestAdapter({ resolveSecret: async () => SECRET, fetch: f as unknown as typeof fetch });
    expect(await a.checkHealth(ctx, ident({ outputs: { instance_ids: 'i-1,i-2' } }))).toMatchObject({ state: 'DEGRADED', message: '1/2 instance(s) running' });
    expect((await a.checkHealth(ctx, ident({ serviceKind: 'database.postgresql', outputs: { id: 'db-1' } }))).state).toBe('HEALTHY');
    expect((await a.checkHealth(ctx, ident({ serviceKind: 'ingress', outputs: { lb_id: 'lb-1', url: 'http://203.0.113.5/' } }))).state).toBe('HEALTHY');
    expect(databaseState('rebalancing')).toBe('DEGRADED');
    expect(databaseState('poweroff')).toBe('UNHEALTHY');
  });

  it('checks the bucket with the subscription keys', async () => {
    const api = fakeVultr({ '/object-storage/os-1': { object_storage: { id: 'os-1', status: 'active', s3_hostname: 'ewr1.vultrobjects.com', s3_access_key: 'AK', s3_secret_key: 'SK' } } });
    const headBucket = vi.fn().mockResolvedValue(undefined);
    const a = new TestAdapter({ resolveSecret: async () => SECRET, fetch: api.fetch, headBucket });
    const h = await a.checkHealth(ctx, ident({ serviceKind: 'object-storage', outputs: { id: 'os-1', bucket: 'b1' } }));
    expect(h.state).toBe('HEALTHY');
    expect(headBucket.mock.calls[0]![0]).toMatchObject({ endpoint: 'https://ewr1.vultrobjects.com', bucket: 'b1', accessKeyId: 'AK' });
  });

  it('probes existence: 404 is gone, other failures are unknown', async () => {
    const api = fakeVultr({ '/databases/db-1': { database: { id: 'db-1' } }, '/databases/db-err': 500 });
    const a = new TestAdapter({ resolveSecret: async () => SECRET, fetch: api.fetch });
    const state = (id: string) => JSON.stringify({ resources: [{ mode: 'managed' }], outputs: { all: { value: { id } } } });
    const db = (name: string) => ident({ serviceKind: 'database.postgresql', capability: 'managed-postgres', name });
    a.store.objects.set(stateKeyFor('live'), state('db-1'));
    a.store.objects.set(stateKeyFor('gone'), state('db-gone'));
    a.store.objects.set(stateKeyFor('err'), state('db-err'));
    expect(await a.probeExists(ctx, db('live'))).toBe(true);
    expect(await a.probeExists(ctx, db('gone'))).toBe(false);
    expect(await a.probeExists(ctx, db('err'))).toBeUndefined();
    expect(await a.probeExists(ctx, db('never'))).toBe(false);
  });

  it('reads database and storage credentials from the API', async () => {
    const api = fakeVultr({
      '/databases/db-1': { database: { id: 'db-1', database_engine: 'pg', host: 'vpc-x.vultrdb.com', public_host: 'public-x.vultrdb.com', port: '16751', user: 'vultradmin', password: 'p@ss', dbname: 'defaultdb' } },
      '/databases/c-1': { database: { id: 'c-1', database_engine: 'valkey', host: 'c.vultrdb.com', port: '16752', user: 'default', password: 'pw' } },
      '/object-storage/os-1': { object_storage: { id: 'os-1', s3_hostname: 'ewr1.vultrobjects.com', s3_access_key: 'AK', s3_secret_key: 'SK' } },
    });
    const a = new TestAdapter({ resolveSecret: async () => SECRET, fetch: api.fetch });
    expect(await a.readSecret(ctx, 'vultr-db://db-1')).toEqual({
      url: 'postgresql://vultradmin:p%40ss@public-x.vultrdb.com:16751/defaultdb?sslmode=require',
      host: 'public-x.vultrdb.com',
      port: '16751',
      username: 'vultradmin',
      password: 'p@ss',
      database: 'defaultdb',
    });
    expect((await a.readSecret(ctx, 'vultr-db://c-1')).url).toBe('rediss://default:pw@c.vultrdb.com:16752');
    expect(await a.readSecret(ctx, 'vultr-objstore://os-1')).toEqual({ endpoint: 'https://ewr1.vultrobjects.com', accessKeyId: 'AK', secretAccessKey: 'SK' });
    await expect(a.readSecret(ctx, 'arn:aws:secret')).rejects.toMatchObject({ code: 'VULTR_SECRET_REF_UNKNOWN' });
  });

  it('restarts the service by rebooting its instances', async () => {
    const api = fakeVultr({ 'POST /instances/reboot': undefined });
    const a = new TestAdapter({ resolveSecret: async () => SECRET, fetch: api.fetch });
    expect(a.actions('instance-docker').map((x) => x.name)).toEqual(['restart']);
    expect(a.actions('managed-postgres')).toEqual([]);
    const r = await a.runAction(ctx, ident({ outputs: { instance_ids: 'i-1,i-2' } }), { action: 'restart', params: {} });
    expect(r.status).toBe('started');
    expect(api.calls[0]).toMatchObject({ method: 'POST', body: { instance_ids: ['i-1', 'i-2'] } });
    await expect(a.runAction(ctx, ident({ capability: 'managed-postgres' }), { action: 'restart', params: {} })).rejects.toMatchObject({ code: 'VULTR_ACTION_UNSUPPORTED' });
  });

  it('treats instance replacements as routine rollouts', async () => {
    const a = new TestAdapter({ resolveSecret: async () => SECRET, runner: fakeRunner({}), fetch: fakeVultr({}).fetch });
    expect((await a.planResource(ctx, request({}))).destructive).toBe(false);
  });
});

/**
 * Contract fixture: state in memory, a fake OpenTofu writing to the same store, and the API
 * answering for the account, the Object Storage catalog and the subscriptions it has applied.
 * The sample is an Object Storage subscription; moving it to another cluster recreates it,
 * which is the destructive change.
 */
runAdapterContract('VultrAdapter', () => {
  const store = new MemoryStateStore();
  const api = fakeVultr({
    '/account': { account: { name: 'Acme Ltda' } },
    '/object-storage/clusters': { clusters: [{ id: 9, region: 'ewr', hostname: 'ewr2.vultrobjects.com', deploy: 'yes' }, { id: 11, region: 'ewr', hostname: 'ewr1.vultrobjects.com', deploy: 'yes' }] },
    '/object-storage/clusters/9/tiers': { tiers: [{ id: 5, slug: 'tier_standard', price: 18 }] },
    '/object-storage/clusters/11/tiers': { tiers: [{ id: 5, slug: 'tier_standard', price: 20 }] },
    '/object-storage/os-files': () => (tofu.isLive('id', 'os-files') ? { object_storage: { id: 'os-files', status: 'active' } } : 404),
  });
  const tofu = new FakeTofu({
    state: store,
    outputs: (inputs) => ({
      kind: 'object-storage',
      id: 'os-files',
      bucket: String(inputs.name),
      cluster_id: Number(inputs.cluster_id),
      tier_id: Number(inputs.tier_id),
      endpoint: inputs.cluster_id === 9 ? 'https://ewr2.vultrobjects.com' : 'https://ewr1.vultrobjects.com',
      secret_ref: 'vultr-objstore://os-files',
    }),
    replaceOn: ['cluster_id'],
  });
  const sampleRequest = request({ resourceId: 'files', serviceKind: 'object-storage', capability: 'object-storage', name: 'ork-acme-prod-files', spec: { versioning: true }, dependencyOutputs: {} });
  return {
    adapter: new TestAdapter({ resolveSecret: async () => SECRET, fetch: api.fetch, runner: tofu.runner }, store),
    context: ctx,
    sampleRequest,
    secrets: ['vk-secret', 'sk-state'],
    replacingRequest: { ...sampleRequest, spec: { versioning: true, providerOverrides: { vultr: { clusterId: 11, tierId: 5 } } }, idempotencyKey: 'k2' },
  };
});
