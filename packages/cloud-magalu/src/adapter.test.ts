// SPDX-License-Identifier: AGPL-3.0-only
import type { CloudTarget, ProviderContext, ResourceRequest } from '@orkstage/cloud-core';
import { runAdapterContract } from '@orkstage/cloud-core/testing';
import { stateKeyFor, type OpenTofuAdapterOptions } from '@orkstage/cloud-tofu';
import { FakeTofu, MemoryStateStore } from '@orkstage/cloud-tofu/testing';
import type { TofuRunner } from '@orkstage/iac';
import { describe, expect, it, vi } from 'vitest';
import { MagaluAdapter } from './adapter.js';
import { MAGALU_CAPABILITIES } from './catalog.js';
import { moduleCall } from './stacks.js';

const SECRET = { apiKey: 'api-key-value', stateAccessKeyId: 'key-pair-id', stateSecretAccessKey: 'key-pair-secret' };

/** Same adapter with state kept in memory instead of Object Storage (the S3 SDK does not use fetch). */
class TestAdapter extends MagaluAdapter {
  constructor(
    opts: OpenTofuAdapterOptions,
    readonly store = new MemoryStateStore(),
  ) {
    super(opts);
  }
  protected override stateStore() {
    return this.store;
  }
}

const target: CloudTarget = {
  id: 't1',
  provider: 'magalu',
  name: 'Magalu',
  config: { stateBucket: 'acme-tfstate' },
  credentialRef: 'env://MGC',
  allowedRegions: ['br-se1', 'br-ne1'],
  defaultRegion: 'br-se1',
};
const ctx: ProviderContext = { target, region: 'br-se1', correlationId: 'c1' };

const network = { kind: 'network', vpc_id: 'vpc-1', network_id: 'vpc-1', subnet_id: 'sn-1', subnetpool_id: 'sp-1', availability_zone: 'br-se1-a', cidr: '10.40.0.0/16', internal_sg_id: 'sg-1' };

const request = (over: Partial<ResourceRequest> = {}): ResourceRequest => ({
  resourceId: 'api',
  serviceKind: 'compute.container-service',
  capability: 'vm-docker',
  name: 'ork-acme-prod-api',
  tags: { 'platform:environment': 'production' },
  spec: { image: 'ghcr.io/acme/api@sha256:abc', cpu: 0.5, memoryMiB: 1536, replicas: 2, port: 8080, public: true, healthCheckPath: '/health' },
  dependencyOutputs: { network },
  idempotencyKey: 'k',
  ...over,
});

type Call = { url: string; init?: RequestInit };
function fakeFetch(routes: Record<string, { status?: number; body?: unknown }>, calls: Call[] = []) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const hit = Object.entries(routes).find(([path]) => url.endsWith(path));
    if (!hit) return new Response('not found', { status: 404 });
    return new Response(hit[1].body === undefined ? null : JSON.stringify(hit[1].body), { status: hit[1].status ?? 200 });
  }) as typeof fetch;
}

const adapter = (over: { fetch?: typeof fetch; runner?: TofuRunner } = {}) => new TestAdapter({ resolveSecret: async () => JSON.stringify(SECRET), ...over });

describe('catalog', () => {
  it('has one default per kind and only verified Magalu Cloud regions', () => {
    const kinds = new Set(MAGALU_CAPABILITIES.map((c) => c.serviceKind));
    for (const kind of kinds) expect(MAGALU_CAPABILITIES.filter((c) => c.serviceKind === kind && c.isDefault)).toHaveLength(1);
    for (const c of MAGALU_CAPABILITIES) expect(c.regions).toEqual(['br-se1', 'br-ne1']);
    expect([...kinds].sort()).toEqual(['compute.container-service', 'database.postgresql', 'network', 'object-storage']);
  });
});

describe('root configuration', () => {
  it('points the backend at Object Storage and passes secrets only as sensitive variables', () => {
    const config = adapter().rootConfig(ctx, request()) as {
      terraform: { backend: { s3: Record<string, unknown> }; required_providers: Record<string, { source: string }> };
      provider: { mgc: Record<string, string> };
      variable: Record<string, { sensitive: boolean }>;
      module: { resource: { source: string } };
    };
    expect(config.terraform.backend.s3).toMatchObject({ bucket: 'acme-tfstate', key: stateKeyFor('ork-acme-prod-api'), endpoints: { s3: 'https://br-se1.magaluobjects.com' }, use_path_style: true, use_lockfile: false });
    expect(config.terraform.required_providers.mgc!.source).toBe('MagaluCloud/mgc');
    expect(config.terraform.required_providers.tls).toBeDefined();
    expect(config.provider.mgc).toEqual({ region: 'br-se1', api_key: '${var.mgc_api_key}', key_pair_id: '${var.mgc_key_pair_id}', key_pair_secret: '${var.mgc_key_pair_secret}' });
    expect(Object.values(config.variable).every((v) => v.sensitive)).toBe(true);
    expect(config.module.resource.source).toBe('/modules/magalu/container-service');
  });

  it('applies with credentials in the runner environment only', async () => {
    const runner = {
      apply: vi.fn().mockResolvedValue({ outputs: { all: { kind: 'object-storage', bucket: 'ork-acme-prod-files' } }, changes: { add: 1, change: 0, remove: 0 } }),
    } as unknown as TofuRunner;
    const a = adapter({ runner });
    const res = await a.ensureResource(ctx, request({ serviceKind: 'object-storage', capability: 'object-storage', name: 'ork-acme-prod-files', spec: { versioning: true }, dependencyOutputs: {} }));
    expect(res.providerResourceId).toBe('ork-acme-prod-files');
    const stack = vi.mocked(runner.apply).mock.calls[0]![0];
    expect(stack.env).toEqual({
      TF_VAR_mgc_api_key: 'api-key-value',
      TF_VAR_mgc_key_pair_id: 'key-pair-id',
      TF_VAR_mgc_key_pair_secret: 'key-pair-secret',
      AWS_ACCESS_KEY_ID: 'key-pair-id',
      AWS_SECRET_ACCESS_KEY: 'key-pair-secret',
    });
    const text = JSON.stringify(stack.config);
    for (const v of Object.values(SECRET)) expect(text).not.toContain(v);
  });
});

describe('module inputs', () => {
  it('sizes VMs, wires the network and passes dependency references, never values', () => {
    const { module, inputs } = moduleCall(ctx, request({
      dependencyOutputs: { network, 'orders-db': { kind: 'database.postgresql', host: '10.0.0.5', port: 5432, secret_ref: 'mgc-db://ork-acme-prod-orders-db/db-1' } },
    }));
    expect(module).toBe('container-service');
    expect(inputs).toMatchObject({
      replicas: 2,
      min_vcpu: 1,
      min_ram_gib: 2,
      port: 8080,
      public: true,
      load_balancer: true,
      health_path: '/health',
      vpc_id: 'vpc-1',
      subnet_id: 'sn-1',
      availability_zone: 'br-se1-a',
      internal_sg_id: 'sg-1',
      ssh_key_name: '',
      environment: { PORT: '8080', ORDERS_DB_HOST: '10.0.0.5', ORDERS_DB_PORT: '5432', ORDERS_DB_CREDENTIALS_REF: 'mgc-db://ork-acme-prod-orders-db/db-1' },
    });
  });

  it('uses a single public VM without a load balancer for one replica', () => {
    expect(moduleCall(ctx, request({ spec: { image: 'x', replicas: 1, port: 80, public: true } })).inputs.load_balancer).toBe(false);
  });

  it('requires a network for services', () => {
    expect(() => moduleCall(ctx, request({ dependencyOutputs: {} }))).toThrow(/needs a network/);
  });

  it('maps database size, HA, backups and storage', () => {
    const { module, inputs } = moduleCall(ctx, request({
      serviceKind: 'database.postgresql',
      capability: 'dbaas-postgres',
      name: 'ork-acme-prod-db',
      spec: { version: '16', size: 'large', storageGiB: 10, highAvailability: 'zone-redundant', backup: { enabled: true, retentionDays: 60 } },
      dependencyOutputs: {},
    }));
    expect(module).toBe('postgres');
    expect(inputs).toEqual({
      name: 'ork-acme-prod-db',
      engine_version: '16',
      min_vcpu: 4,
      min_ram_gib: 16,
      family: 'DP',
      instance_type: '',
      volume_size_gib: 20,
      backup_retention_days: 35,
      high_availability: true,
      production: true,
    });
  });

  it('rejects capabilities without a module', () => {
    expect(() => moduleCall(ctx, request({ serviceKind: 'cache.redis', capability: 'redis' }))).toThrow(/not implemented/);
  });
});

describe('validateTarget', () => {
  it('rejects a missing state bucket and unknown regions without calling the API', async () => {
    const calls: Call[] = [];
    const r = await adapter({ fetch: fakeFetch({}, calls) }).validateTarget({ ...ctx, target: { ...target, config: {}, allowedRegions: ['br-se1', 'us-east-1'] } });
    expect(r.ok).toBe(false);
    expect(r.checks.map((c) => c.name)).toEqual(['State bucket', 'Regions']);
    expect(calls).toHaveLength(0);
  });

  it('reports the tenant behind the API key, sent in the X-API-Key header', async () => {
    const calls: Call[] = [];
    const r = await adapter({ fetch: fakeFetch({ '/br-se1/network/v0/vpcs': { body: { vpcs: [{ id: 'v', tenant_id: 'tenant-1' }] } } }, calls) }).validateTarget(ctx);
    expect(r).toMatchObject({ ok: true, identity: 'tenant-1' });
    expect(new Headers(calls[0]!.init!.headers).get('x-api-key')).toBe('api-key-value');
  });

  it('fails clearly when the API key is rejected', async () => {
    const r = await adapter({ fetch: fakeFetch({ '/network/v0/vpcs': { status: 401, body: { message: 'invalid' } } }) }).validateTarget(ctx);
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.name === 'API key')).toMatchObject({ status: 'error', message: expect.stringContaining('rejected') });
  });
});

describe('health, existence and actions', () => {
  const svc = { resourceId: 'api', serviceKind: 'compute.container-service', capability: 'vm-docker', name: 'ork-acme-prod-api' };
  const outputs = { kind: 'compute.container-service', instance_ids: 'vm-1,vm-2', private_ips: '10.0.0.2,10.0.0.3', url: 'http://10.0.0.2:8080' };

  it('reads VM states from the compute API', async () => {
    const healthy = await adapter({ fetch: fakeFetch({ '/compute/v1/instances/vm-1': { body: { state: 'running' } }, '/compute/v1/instances/vm-2': { body: { state: 'running' } } }) }).checkHealth(ctx, { ...svc, outputs });
    expect(healthy).toMatchObject({ state: 'HEALTHY', message: '2/2 VM(s) running' });
    const degraded = await adapter({ fetch: fakeFetch({ '/compute/v1/instances/vm-1': { body: { state: 'running' } }, '/compute/v1/instances/vm-2': { body: { state: 'stopped' } } }) }).checkHealth(ctx, { ...svc, outputs });
    expect(degraded.state).toBe('DEGRADED');
  });

  it('maps DBaaS status and reports deleted resources as gone', async () => {
    const db = { resourceId: 'db', serviceKind: 'database.postgresql', capability: 'dbaas-postgres', name: 'ork-acme-prod-db', outputs: { kind: 'database.postgresql', instance_id: 'db-1', deployment: 'instance' } };
    const a = adapter({ fetch: fakeFetch({ '/database/v2/instances/db-1': { body: { status: 'ACTIVE' } } }) });
    expect((await a.checkHealth(ctx, db)).state).toBe('HEALTHY');
    a.store.objects.set(stateKeyFor('ork-acme-prod-api'), JSON.stringify({ resources: [{ mode: 'managed' }], outputs: { all: { value: outputs } } }));
    expect(await a.probeExists(ctx, svc)).toBe(false);
  });

  it('reboots every VM of a service', async () => {
    const calls: Call[] = [];
    const a = adapter({ fetch: fakeFetch({ '/reboot': { status: 204 } }, calls) });
    expect(a.actions('vm-docker').map((x) => x.name)).toEqual(['restart']);
    const r = await a.runAction(ctx, { ...svc, outputs }, { action: 'restart', params: {} });
    expect(r.status).toBe('started');
    expect(calls.map((c) => [c.init?.method, c.url])).toEqual([
      ['POST', 'https://api.magalu.cloud/br-se1/compute/v1/instances/vm-1/reboot'],
      ['POST', 'https://api.magalu.cloud/br-se1/compute/v1/instances/vm-2/reboot'],
    ]);
  });
});

describe('readSecret', () => {
  const state = {
    resources: [{ mode: 'managed', type: 'random_password', name: 'master', instances: [{ attributes: { result: 'p@ss/w0rd' } }] }],
    outputs: { all: { value: { instance_id: 'db-1', host: '10.0.0.5', port: 5432, database: 'postgres', username: 'app' } } },
  };

  it('returns the generated credentials recorded in the database state', async () => {
    const a = adapter();
    a.store.objects.set(stateKeyFor('ork-acme-prod-db'), JSON.stringify(state));
    expect(await a.readSecret(ctx, 'mgc-db://ork-acme-prod-db/db-1')).toEqual({
      host: '10.0.0.5',
      port: '5432',
      database: 'postgres',
      username: 'app',
      password: 'p@ss/w0rd',
      url: 'postgresql://app:p%40ss%2Fw0rd@10.0.0.5:5432/postgres',
    });
  });

  it('refuses references that do not match the recorded database', async () => {
    const a = adapter();
    a.store.objects.set(stateKeyFor('ork-acme-prod-db'), JSON.stringify(state));
    await expect(a.readSecret(ctx, 'mgc-db://ork-acme-prod-db/other')).rejects.toMatchObject({ code: 'MAGALU_SECRET_NOT_FOUND' });
    await expect(a.readSecret(ctx, 'arn:aws:secretsmanager:x')).rejects.toMatchObject({ code: 'MAGALU_SECRET_REF_INVALID' });
  });
});

/**
 * Contract fixture: state in memory, a fake OpenTofu writing to the same store, and the regional
 * API answering for the VPCs it has applied. There is no replacing request: a VPC takes only its
 * name and a CIDR derived from it, a bucket only versioning, and VM replacements are routine
 * rollouts on Magalu Cloud, so nothing a request can change is planned as a destructive change.
 */
runAdapterContract('MagaluAdapter', () => {
  const store = new MemoryStateStore();
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    expect((init?.headers as Record<string, string> | undefined)?.['X-API-Key']).toBe(SECRET.apiKey);
    if (url.pathname === '/br-se1/network/v0/vpcs') return Response.json({ vpcs: [{ id: 'vpc-default', tenant_id: 'tenant-1' }] });
    const vpc = /^\/br-se1\/network\/v0\/vpcs\/([^/]+)$/.exec(url.pathname)?.[1];
    if (vpc && tofu.isLive('vpc_id', decodeURIComponent(vpc))) return Response.json({ id: vpc, status: 'created' });
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  const tofu = new FakeTofu({
    state: store,
    outputs: (inputs) => ({ kind: 'network', vpc_id: `vpc-${String(inputs.name)}`, network_id: `vpc-${String(inputs.name)}`, subnet_id: 'sn-1', subnetpool_id: 'sp-1', availability_zone: 'br-se1-a', cidr: String(inputs.cidr), internal_sg_id: 'sg-1' }),
  });
  return {
    adapter: new TestAdapter({ resolveSecret: async () => JSON.stringify(SECRET), fetch: fetchFn, runner: tofu.runner }, store),
    context: ctx,
    sampleRequest: request({ resourceId: 'net', serviceKind: 'network', capability: 'vpc', name: 'ork-acme-prod-net', spec: {}, dependencyOutputs: {} }),
    secrets: [SECRET.apiKey, SECRET.stateSecretAccessKey],
  };
});
