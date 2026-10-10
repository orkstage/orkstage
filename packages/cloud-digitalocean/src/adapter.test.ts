import type { CloudTarget, ProviderContext, ResourceRequest } from '@orkstage/cloud-core';
import type { StateStore } from '@orkstage/cloud-tofu';
import type { TofuRunner } from '@orkstage/iac';
import { describe, expect, it, vi } from 'vitest';
import { DigitalOceanAdapter } from './adapter.js';
import { DIGITALOCEAN_CAPABILITIES } from './catalog.js';
import { appCanJoinVpc, appRegionFor } from './config.js';
import { parseLogLine, toProviderDeployment } from './health.js';
import { appAutoscaling, appInstanceSize, doTags, moduleCall, parseImage, postgresStorageMiB, virtualIngress } from './stacks.js';

const SECRET = { token: 'dop_v1_secret_token', spacesAccessKeyId: 'SPACESKEY', spacesSecretAccessKey: 'spaces-secret-value' };

class MemoryStore implements StateStore {
  readonly location = 'memory://state';
  readonly objects = new Map<string, string>();
  async check() {}
  async get(key: string) {
    return this.objects.get(key) ?? null;
  }
  async put(key: string, body: string) {
    this.objects.set(key, body);
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
}

/** Same adapter with state kept in memory instead of Spaces. */
class TestAdapter extends DigitalOceanAdapter {
  readonly store = new MemoryStore();
  protected override stateStore() {
    return this.store;
  }
}

const target: CloudTarget = {
  id: 't1',
  provider: 'digitalocean',
  name: 'Acme DO',
  config: { stateBucket: 'acme-tfstate', stateRegion: 'nyc3' },
  credentialRef: 'env://DO_CREDS',
  allowedRegions: ['nyc1', 'nyc3', 'fra1'],
  defaultRegion: 'nyc1',
};
const ctx: ProviderContext = { target, region: 'nyc1', correlationId: 'c1' };
const ctxNyc3: ProviderContext = { ...ctx, region: 'nyc3' };

const network = { kind: 'network', network_id: 'vpc-uuid', vpc_id: 'vpc-uuid', cidr: '10.116.0.0/20', region: 'nyc1' };
const database = { kind: 'database.postgresql', cluster_id: 'db-uuid', cluster_name: 'ork-acme-prod-db', host: 'private-db.example', port: 25060, public_access: false, secret_ref: 'do-db://db-uuid' };

const request = (over: Partial<ResourceRequest>): ResourceRequest => ({
  resourceId: 'api',
  serviceKind: 'compute.container-service',
  capability: 'app-platform',
  name: 'ork-acme-prod-api',
  tags: { 'platform:managed': 'true', 'platform:environment': 'production' },
  spec: { image: 'ghcr.io/acme/api@sha256:abc', cpu: 0.5, memoryMiB: 1024, replicas: 2, port: 8080, public: true, healthCheckPath: '/health' },
  dependencyOutputs: { network },
  idempotencyKey: 'k',
  ...over,
});

type Handler = (url: string, init: RequestInit) => { status?: number; body?: unknown; text?: string } | undefined;

function fakeFetch(handler: Handler) {
  return vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const r = handler(url, init) ?? { status: 404, body: { id: 'not_found', message: 'not found' } };
    const text = r.text ?? (r.body === undefined ? '' : JSON.stringify(r.body));
    return new Response(text, { status: r.status ?? 200 });
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

const adapter = (fetchImpl?: typeof fetch, runner?: TofuRunner) => new TestAdapter({ resolveSecret: async () => JSON.stringify(SECRET), fetch: fetchImpl, runner });

describe('parseImage', () => {
  it('maps registries App Platform can pull from', () => {
    expect(parseImage('registry.digitalocean.com/acme/api:1.2.0')).toEqual({ registry_type: 'DOCR', registry: '', repository: 'api', tag: '1.2.0', digest: '' });
    expect(parseImage('ghcr.io/acme/tools/api@sha256:abc')).toEqual({ registry_type: 'GHCR', registry: 'acme', repository: 'tools/api', tag: '', digest: 'sha256:abc' });
    expect(parseImage('nginx')).toEqual({ registry_type: 'DOCKER_HUB', registry: 'library', repository: 'nginx', tag: 'latest', digest: '' });
    expect(parseImage('docker.io/bitnami/redis:7')).toMatchObject({ registry_type: 'DOCKER_HUB', registry: 'bitnami', repository: 'redis', tag: '7' });
  });

  it('rejects other registries', () => {
    expect(() => parseImage('123.dkr.ecr.us-east-1.amazonaws.com/api:1')).toThrow(/cannot pull/);
  });
});

describe('sizing', () => {
  it('picks the smallest fitting App Platform size', () => {
    expect(appInstanceSize(0.25, 512, { multiple: false, autoscaling: false })).toBe('apps-s-1vcpu-0.5gb');
    expect(appInstanceSize(0.5, 1024, { multiple: true, autoscaling: false })).toBe('apps-s-1vcpu-1gb');
    expect(appInstanceSize(1, 1024, { multiple: true, autoscaling: true })).toBe('apps-d-1vcpu-1gb');
    expect(() => appInstanceSize(16, 1024, { multiple: false, autoscaling: false })).toThrow(/No App Platform size/);
  });

  it('keeps autoscaling min below max and at least one instance', () => {
    expect(appAutoscaling({ autoscaling: { minReplicas: 0, maxReplicas: 1, targetCpuPercent: 70 } })).toEqual({ min_instance_count: 1, max_instance_count: 2, cpu_percent: 70 });
    expect(appAutoscaling({})).toBeNull();
  });

  it('sizes Postgres disks within the plan range', () => {
    expect(postgresStorageMiB('db-s-1vcpu-1gb', 10)).toBeNull();
    expect(postgresStorageMiB('db-s-1vcpu-1gb', 25)).toBe(30 * 1024);
    expect(postgresStorageMiB('db-s-1vcpu-1gb', 500)).toBe(30 * 1024);
  });

  it('turns tags into DigitalOcean tag names', () => {
    expect(doTags({ 'platform:environment': 'production', team: 'a b' })).toEqual(['platform:environment:production', 'team:a_b']);
  });
});

describe('regions', () => {
  it('maps datacenters to App Platform regions and VPC pairing', () => {
    expect(appRegionFor('nyc3')).toBe('nyc');
    expect(appRegionFor('fra1')).toBe('fra');
    expect(appRegionFor('xyz1')).toBeUndefined();
    expect(appCanJoinVpc('nyc1')).toBe(true);
    expect(appCanJoinVpc('nyc3')).toBe(false);
  });
});

describe('moduleCall', () => {
  it('wires an App Platform service to the VPC and a managed database by name', () => {
    const { module, inputs } = moduleCall(ctx, request({ dependencyOutputs: { network, 'orders-db': database } }));
    expect(module).toBe('container-service');
    expect(inputs).toMatchObject({
      name: 'ork-acme-prod-api',
      region: 'nyc',
      image: { registry_type: 'GHCR', registry: 'acme', repository: 'api', digest: 'sha256:abc' },
      instance_size_slug: 'apps-s-1vcpu-1gb',
      instance_count: 2,
      public: true,
      vpc_id: 'vpc-uuid',
      database_clusters: { ORDERS_DB: 'ork-acme-prod-db' },
      environment: { ORDERS_DB_HOST: 'private-db.example', ORDERS_DB_PORT: '25060', PORT: '8080' },
      health_check_path: '/health',
    });
    expect(JSON.stringify(inputs)).not.toContain('do-db://');
  });

  it('refuses a private database the app cannot reach from its region', () => {
    expect(() => moduleCall(ctxNyc3, request({ dependencyOutputs: { network, db: database } }))).toThrow(/accepts connections only from its VPC/);
    const { inputs } = moduleCall(ctxNyc3, request({ dependencyOutputs: { network, db: { ...database, public_access: true } } }));
    expect(inputs).toMatchObject({ vpc_id: '', database_clusters: { DB: 'ork-acme-prod-db' } });
  });

  it('applies the ingress route prefix and passes foreign references as references', () => {
    const ingress = virtualIngress(request({ serviceKind: 'ingress', capability: 'app-platform-ingress', spec: { routes: [{ service: 'api', pathPrefix: '/api' }] } }))!;
    const { inputs } = moduleCall(ctx, request({ spec: { image: 'nginx', port: 80 }, dependencyOutputs: { network, ingress, cache: { kind: 'database.postgresql', host: 'h', secret_ref: 'kv://other' } } }));
    expect(inputs).toMatchObject({ public: true, path_prefix: '/api', environment: { CACHE_CREDENTIALS_REF: 'kv://other' } });
  });

  it('maps databases, caches and buckets', () => {
    const pg = moduleCall(ctx, request({ resourceId: 'db', serviceKind: 'database.postgresql', capability: 'managed-postgres', spec: { size: 'micro', highAvailability: 'zone-redundant', storageGiB: 40, version: '17' } }));
    expect(pg.inputs).toMatchObject({ size: 'db-s-1vcpu-2gb', node_count: 2, storage_size_mib: 40 * 1024, vpc_id: 'vpc-uuid', vpc_cidr: '10.116.0.0/20', public_access: false });
    expect(pg.inputs.tags).toContain('platform:environment:production');

    const cache = moduleCall(ctx, request({ resourceId: 'cache', serviceKind: 'cache.redis', capability: 'managed-valkey', spec: { size: 'small', replicas: 5 } }));
    expect(cache).toMatchObject({ module: 'redis', inputs: { size: 'db-s-1vcpu-2gb', node_count: 3 } });

    const bucket = moduleCall(ctxNyc3, request({ resourceId: 'files', serviceKind: 'object-storage', capability: 'spaces', spec: { versioning: true, retentionDays: 30 } }));
    expect(bucket.inputs).toMatchObject({ region: 'nyc3', versioning: true, retention_days: 30, force_destroy: false });
    expect(String(bucket.inputs.name)).toMatch(/^ork-acme-prod-api-[0-9a-f]{8}$/);
    expect(() => moduleCall(ctx, request({ serviceKind: 'object-storage', capability: 'spaces', spec: {} }))).toThrow(/Spaces is not offered in nyc1/);
  });

  it('requires a network for databases and rejects unknown capabilities', () => {
    expect(() => moduleCall(ctx, request({ serviceKind: 'database.postgresql', capability: 'managed-postgres', dependencyOutputs: {} }))).toThrow(/needs a network/);
    expect(() => moduleCall(ctx, request({ capability: 'load-balancer' }))).toThrow(/not implemented/);
  });
});

describe('DigitalOceanAdapter provisioning', () => {
  it('renders the Spaces backend and passes credentials only as environment variables', async () => {
    const runner = {
      apply: vi.fn().mockResolvedValue({ outputs: { all: { kind: 'network', network_id: 'vpc-uuid', cidr: '10.0.0.0/20' } }, changes: { add: 1, change: 0, remove: 0 } }),
    } as unknown as TofuRunner;
    const a = adapter(fakeFetch(() => undefined), runner);
    const result = await a.ensureResource(ctx, request({ resourceId: 'net', serviceKind: 'network', capability: 'vpc', dependencyOutputs: {} }));
    expect(result).toMatchObject({ providerResourceId: 'vpc-uuid', unchanged: false });
    const stack = vi.mocked(runner.apply).mock.calls[0]![0];
    const config = stack.config as { terraform: { backend: { s3: Record<string, unknown> }; required_providers: Record<string, unknown> }; module: { resource: { source: string } } };
    expect(config.terraform.backend.s3).toMatchObject({ bucket: 'acme-tfstate', region: 'us-east-1', endpoints: { s3: 'https://nyc3.digitaloceanspaces.com' }, use_lockfile: true });
    expect(config.terraform.required_providers.digitalocean).toEqual({ source: 'digitalocean/digitalocean', version: '~> 2.100' });
    expect(config.module.resource.source).toBe('/modules/digitalocean/network');
    expect(stack.env).toEqual({
      DIGITALOCEAN_TOKEN: SECRET.token,
      SPACES_ACCESS_KEY_ID: SECRET.spacesAccessKeyId,
      SPACES_SECRET_ACCESS_KEY: SECRET.spacesSecretAccessKey,
      AWS_ACCESS_KEY_ID: SECRET.spacesAccessKeyId,
      AWS_SECRET_ACCESS_KEY: SECRET.spacesSecretAccessKey,
    });
    for (const value of Object.values(SECRET)) expect(JSON.stringify(stack.config)).not.toContain(value);
  });

  it('answers App Platform ingress without a runner', async () => {
    const a = adapter(fakeFetch(() => undefined));
    const r = await a.ensureResource(ctx, request({ serviceKind: 'ingress', capability: 'app-platform-ingress', spec: { routes: [{ service: 'api', pathPrefix: '/' }] } }));
    expect(r.outputs).toMatchObject({ kind: 'ingress', mode: 'app-platform' });
  });

  it('lists every capability with a default per kind', () => {
    const kinds = new Set(DIGITALOCEAN_CAPABILITIES.filter((c) => c.isDefault).map((c) => c.serviceKind));
    expect(kinds).toEqual(new Set(['network', 'compute.container-service', 'database.postgresql', 'cache.redis', 'object-storage', 'ingress']));
  });
});

describe('DigitalOceanAdapter.validateTarget', () => {
  it('rejects malformed configuration without calling DigitalOcean', async () => {
    const f = fakeFetch(() => undefined);
    const result = await adapter(f).validateTarget({ ...ctx, target: { ...target, config: { stateBucket: 'X' } } });
    expect(result.checks.map((c) => c.name)).toEqual(['State bucket', 'State region']);
    expect(f).not.toHaveBeenCalled();
  });

  it('reports the team, never the email, and flags missing token scopes', async () => {
    const f = fakeFetch((url, init) => {
      expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${SECRET.token}`);
      if (url.endsWith('/v2/account')) return { body: { account: { uuid: 'acc-uuid', email: 'owner@acme.com', status: 'active', team: { uuid: 'team-uuid', name: 'Acme' } } } };
      if (url.includes('/v2/apps')) return { status: 403, body: { id: 'forbidden', message: 'missing scope' } };
      return { body: {} };
    });
    const result = await adapter(f).validateTarget(ctx, { serviceKinds: ['compute.container-service'] });
    expect(result.identity).toBe('Acme');
    expect(JSON.stringify(result)).not.toContain('owner@acme.com');
    expect(result.checks.find((c) => c.name === 'Token scopes')).toMatchObject({ status: 'error', message: expect.stringContaining('app') });
    expect(result.ok).toBe(false);
  });

  it('reports a rejected token', async () => {
    const result = await adapter(fakeFetch(() => ({ status: 401, body: { id: 'unauthorized' } }))).validateTarget(ctx);
    expect(result.checks[0]).toMatchObject({ name: 'Account access', status: 'error', message: 'DigitalOcean rejected the API token.' });
  });
});

describe('DigitalOceanAdapter operations', () => {
  const app = { resourceId: 'api', serviceKind: 'compute.container-service', capability: 'app-platform', name: 'ork-acme-prod-api', outputs: { kind: 'compute.container-service', service_id: 'app-1', component: 'service', url: 'https://api.ondigitalocean.app', health_check_path: '/health' } };

  it('reads managed database connections for do-db references', async () => {
    const f = fakeFetch((url) => (url.endsWith('/v2/databases/db-uuid') ? { body: { database: { id: 'db-uuid', status: 'online', connection: { uri: 'postgresql://doadmin:pw@h:25060/defaultdb', host: 'h', port: 25060, user: 'doadmin', password: 'pw', database: 'defaultdb' } } } } : undefined));
    expect(await adapter(f).readSecret(ctx, 'do-db://db-uuid')).toEqual({ url: 'postgresql://doadmin:pw@h:25060/defaultdb', host: 'h', port: '25060', username: 'doadmin', password: 'pw', database: 'defaultdb' });
    await expect(adapter(f).readSecret(ctx, 'kv://x')).rejects.toThrow(/do-db/);
  });

  it('checks App Platform health through the API and the public URL', async () => {
    const f = fakeFetch((url) => {
      if (url.endsWith('/v2/apps/app-1')) return { body: { app: { id: 'app-1', live_url: 'https://api.ondigitalocean.app', active_deployment: { id: 'd1', phase: 'ACTIVE' } } } };
      if (url === 'https://api.ondigitalocean.app/health') return { text: 'ok' };
      return undefined;
    });
    expect((await adapter(f).checkHealth(ctx, app)).state).toBe('HEALTHY');
    const deploying = fakeFetch((url) => (url.endsWith('/v2/apps/app-1') ? { body: { app: { id: 'app-1', in_progress_deployment: { id: 'd1', phase: 'BUILDING' } } } } : undefined));
    expect((await adapter(deploying).checkHealth(ctx, app)).state).toBe('DEGRADED');
  });

  it('maps database status and reports deleted resources as gone', async () => {
    const db = { resourceId: 'db', serviceKind: 'database.postgresql', capability: 'managed-postgres', name: 'ork-acme-prod-db', outputs: database };
    const f = fakeFetch((url) => (url.endsWith('/v2/databases/db-uuid') ? { body: { database: { id: 'db-uuid', status: 'resizing' } } } : undefined));
    expect((await adapter(f).checkHealth(ctx, db)).state).toBe('DEGRADED');

    const a = adapter(fakeFetch(() => undefined));
    a.store.objects.set('orkstage/ork-acme-prod-db.tfstate', JSON.stringify({ resources: [{ mode: 'managed' }], outputs: { all: { value: database } } }));
    expect(await a.probeExists(ctx, db)).toBe(false);
  });

  it('redeploys and restarts through the App Platform API', async () => {
    const calls: { url: string; method?: string; body?: unknown }[] = [];
    const f = fakeFetch((url, init) => {
      calls.push({ url, method: init.method, body: init.body ? JSON.parse(String(init.body)) : undefined });
      return { body: { deployment: { id: 'dep-9', phase: 'PENDING_BUILD' } } };
    });
    const a = adapter(f);
    expect(a.actions('app-platform').map((x) => x.name)).toEqual(['redeploy', 'restart']);
    expect(await a.runAction(ctx, app, { action: 'redeploy', params: {} })).toMatchObject({ reference: 'dep-9', status: 'started' });
    await a.runAction(ctx, app, { action: 'restart', params: {} });
    expect(calls).toEqual([
      { url: 'https://api.digitalocean.com/v2/apps/app-1/deployments', method: 'POST', body: { force_build: true } },
      { url: 'https://api.digitalocean.com/v2/apps/app-1/restart', method: 'POST', body: { components: ['service'] } },
    ]);
    await expect(a.runAction(ctx, { ...app, capability: 'managed-postgres' }, { action: 'restart', params: {} })).rejects.toThrow(/not available/);
  });

  it('lists deployments newest first with mapped phases', async () => {
    const f = fakeFetch((url) =>
      url.includes('/v2/apps/app-1/deployments')
        ? { body: { deployments: [
            { id: 'd2', phase: 'BUILDING', created_at: '2026-10-09T10:00:00Z', cause: 'manual' },
            { id: 'd1', phase: 'ACTIVE', created_at: '2026-10-08T10:00:00Z', phase_last_updated_at: '2026-10-08T10:05:00Z', spec: { services: [{ image: { digest: 'sha256:abc' } }] } },
          ] } }
        : undefined,
    );
    const list = await adapter(f).listDeployments(ctx, app, 5);
    expect(list).toEqual([
      { id: 'd2', status: 'building', createdAt: '2026-10-09T10:00:00Z', message: 'manual' },
      { id: 'd1', status: 'live', createdAt: '2026-10-08T10:00:00Z', finishedAt: '2026-10-08T10:05:00Z', url: 'https://api.ondigitalocean.app', revision: 'sha256:abc' },
    ]);
    expect(toProviderDeployment({ id: 'x', phase: 'ERROR' }).status).toBe('failed');
  });

  it('reads run logs from the link the API returns', async () => {
    const f = fakeFetch((url) => {
      if (url.includes('/components/service/logs')) return { body: { live_url: 'https://logs.example/live' } };
      if (url === 'https://logs.example/live') return { text: 'service 2026-10-09T10:00:00.000Z listening on 8080\nservice 2026-10-09T10:00:01.000Z ERROR boom\n' };
      return undefined;
    });
    const lines = await adapter(f).getLogs(ctx, app, 10);
    expect(lines).toEqual([
      { timestamp: '2026-10-09T10:00:00.000Z', level: 'info', message: 'listening on 8080' },
      { timestamp: '2026-10-09T10:00:01.000Z', level: 'error', message: 'ERROR boom' },
    ]);
    expect(parseLogLine('plain text').message).toBe('plain text');
  });
});
