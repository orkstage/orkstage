// SPDX-License-Identifier: AGPL-3.0-only
import { createVerify, generateKeyPairSync } from 'node:crypto';
import type { CloudTarget, ProviderContext, ResourceRequest } from '@orkstage/cloud-core';
import { stateKeyFor } from '@orkstage/cloud-tofu';
import type { TofuRunner } from '@orkstage/iac';
import { describe, expect, it, vi } from 'vitest';
import { GcpAdapter } from './adapter.js';
import { signAssertion } from './auth.js';
import { GCP_CAPABILITIES } from './catalog.js';
import { gcpConfigChecks, labelsFrom } from './config.js';
import { GcsStateStore, gcsObjectName } from './state.js';
import { cloudRunResources, cloudRunScaling, moduleCall, redisShape } from './stacks.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const key = {
  type: 'service_account',
  project_id: 'acme-prod-123',
  private_key_id: 'kid1',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  client_email: 'deployer@acme-prod-123.iam.gserviceaccount.com',
};
const keyJson = JSON.stringify(key);

const target: CloudTarget = {
  id: 't1',
  provider: 'gcp',
  name: 'Acme prod',
  config: { projectId: 'acme-prod-123', stateBucket: 'acme-orkstage-state' },
  credentialRef: 'env://GCP_KEY',
  allowedRegions: ['us-central1', 'southamerica-east1'],
  defaultRegion: 'us-central1',
};
const ctx: ProviderContext = { target, region: 'us-central1', correlationId: 'c1' };

const network = {
  kind: 'network',
  network_id: 'projects/acme-prod-123/global/networks/ork-acme-prod-net',
  subnet_id: 'projects/acme-prod-123/regions/us-central1/subnetworks/ork-acme-prod-net',
  cidr: '10.20.0.0/20',
  nat: false,
};
const request = (over: Partial<ResourceRequest> = {}): ResourceRequest => ({
  resourceId: 'api',
  serviceKind: 'compute.container-service',
  capability: 'cloud-run',
  name: 'ork-acme-prod-api',
  tags: { 'platform:managed': 'true', 'platform:environment': 'production' },
  spec: { image: 'us-docker.pkg.dev/acme/api@sha256:abc', cpu: 0.5, memoryMiB: 1024, replicas: 2, port: 8080, public: false },
  dependencyOutputs: { network },
  idempotencyKey: 'k',
  ...over,
});

type Handler = (url: URL, init: RequestInit) => { status: number; body?: unknown } | undefined;

/** Fake fetch: answers the token endpoint, then the first handler that matches. */
function fakeFetch(...handlers: Handler[]) {
  const calls: { method: string; url: string; body?: string; auth?: string }[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({ method: init.method ?? 'GET', url: url.toString(), body: typeof init.body === 'string' ? init.body : undefined, auth: headers.authorization });
    let out: { status: number; body?: unknown } | undefined;
    if (url.toString() === 'https://oauth2.googleapis.com/token') out = { status: 200, body: { access_token: 'ya29.test', expires_in: 3600 } };
    for (const h of handlers) out ??= h(url, init);
    out ??= { status: 404, body: { error: { message: 'not found' } } };
    const text = typeof out.body === 'string' ? out.body : out.body === undefined ? '' : JSON.stringify(out.body);
    return new Response(out.status === 204 ? null : text, { status: out.status });
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

function fakeRunner() {
  return {
    apply: vi.fn().mockResolvedValue({ outputs: { all: { kind: 'compute.container-service', service_id: 'projects/acme-prod-123/locations/us-central1/services/ork-acme-prod-api', url: '' } }, changes: { add: 3, change: 0, remove: 0 } }),
    plan: vi.fn(),
    drift: vi.fn(),
    destroy: vi.fn().mockResolvedValue(undefined),
  } as unknown as TofuRunner;
}

const adapterWith = (fetchFn: typeof fetch, runner?: TofuRunner) => new GcpAdapter({ resolveSecret: async () => keyJson, fetch: fetchFn, runner });

describe('configuration', () => {
  it('checks project id, state bucket and region names', () => {
    expect(gcpConfigChecks(target)).toEqual([]);
    const bad = gcpConfigChecks({ ...target, config: { projectId: 'X', stateBucket: '' }, allowedRegions: ['us-east-1a'] });
    expect(bad.map((c) => c.name)).toEqual(['Project id', 'State bucket', 'Regions']);
  });

  it('turns tags into valid labels', () => {
    expect(labelsFrom({ 'platform:managed': 'true', 'Platform:Tenant': 'Acme Corp', '9x': 'y' })).toEqual({ platform_managed: 'true', platform_tenant: 'acme_corp', k_9x: 'y' });
  });

  it('publishes one default per kind', () => {
    const kinds = new Set(GCP_CAPABILITIES.map((c) => c.serviceKind));
    for (const k of kinds) expect(GCP_CAPABILITIES.filter((c) => c.serviceKind === k && c.isDefault)).toHaveLength(1);
  });
});

describe('module inputs', () => {
  it('rounds Cloud Run CPU and memory to valid pairs', () => {
    expect(cloudRunResources(0.25, 512)).toEqual({ cpu: '1', memory: '512Mi' });
    expect(cloudRunResources(1, 6144)).toEqual({ cpu: '2', memory: '6144Mi' });
    expect(cloudRunResources(3, 1024)).toEqual({ cpu: '4', memory: '2048Mi' });
    expect(cloudRunScaling({ replicas: 2 })).toEqual({ min_instances: 2, max_instances: 2 });
    expect(cloudRunScaling({ replicas: 0 })).toEqual({ min_instances: 0, max_instances: 1 });
    expect(cloudRunScaling({ replicas: 1, autoscaling: { minReplicas: 1, maxReplicas: 5, targetCpuPercent: 60 } })).toEqual({ min_instances: 1, max_instances: 5 });
  });

  it('maps cache sizes and replicas to Memorystore tiers', () => {
    expect(redisShape('micro', 0)).toEqual({ tier: 'BASIC', memory_size_gb: 1, replica_count: 0, read_replicas: false });
    expect(redisShape('small', 1)).toMatchObject({ tier: 'STANDARD_HA', replica_count: 1, read_replicas: false });
    expect(redisShape('micro', 3)).toEqual({ tier: 'STANDARD_HA', memory_size_gb: 5, replica_count: 3, read_replicas: true });
  });

  it('wires a Cloud Run service to its network, secrets and buckets', () => {
    const log = vi.fn();
    const call = moduleCall({ ...ctx, log }, request({
      dependencyOutputs: {
        network,
        'orders-db': { kind: 'database.postgresql', host: '10.1.0.3', port: 5432, secret_ref: 'projects/acme-prod-123/secrets/ork-acme-prod-orders-db-credentials' },
        'legacy-db': { kind: 'database.postgresql', host: 'db.example.com', port: 5432, secret_ref: 'arn:aws:secretsmanager:us-east-1:1:secret:x' },
        files: { kind: 'object-storage', bucket: 'ork-acme-prod-files-abc123', endpoint: 'https://storage.googleapis.com/ork-acme-prod-files-abc123' },
      },
    }));
    expect(call.module).toBe('container-service');
    expect(call.inputs).toMatchObject({
      cpu: '1',
      memory: '1024Mi',
      min_instances: 2,
      max_instances: 2,
      public: false,
      network_id: network.network_id,
      subnet_id: network.subnet_id,
      egress: 'PRIVATE_RANGES_ONLY',
      secrets: { ORDERS_DB_CREDENTIALS: 'projects/acme-prod-123/secrets/ork-acme-prod-orders-db-credentials' },
      buckets: ['ork-acme-prod-files-abc123'],
      production: true,
    });
    expect((call.inputs.environment as Record<string, string>).ORDERS_DB_HOST).toBe('10.1.0.3');
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('LEGACY_DB'));
  });

  it('makes services routed through the built in ingress public', () => {
    const call = moduleCall(ctx, request({ dependencyOutputs: { edge: { kind: 'ingress', mode: 'cloud-run', services: 'api' } } }));
    expect(call.inputs).toMatchObject({ public: true, network_id: '', subnet_id: '' });
  });

  it('builds database, cache and bucket inputs', () => {
    const pg = moduleCall(ctx, request({ serviceKind: 'database.postgresql', capability: 'cloud-sql-postgres', spec: { version: '17', size: 'medium', storageGiB: 5, highAvailability: 'zone-redundant', backup: { enabled: true, retentionDays: 14 } } }));
    expect(pg.inputs).toMatchObject({ database_version: 'POSTGRES_17', tier: 'db-custom-1-3840', disk_gib: 10, high_availability: true, backup_retention_days: 14, network_id: network.network_id });
    expect(() => moduleCall(ctx, request({ serviceKind: 'cache.redis', capability: 'memorystore-redis', spec: {}, dependencyOutputs: {} }))).toThrow(/needs a network/);
    const bucket = moduleCall(ctx, request({ serviceKind: 'object-storage', capability: 'gcs', spec: { tier: 'archive', retentionDays: 0 }, tags: {} }));
    expect(bucket.inputs).toMatchObject({ location: 'us-central1', tier: 'archive', retention_days: null, force_destroy: true });
    expect(String(bucket.inputs.name)).toMatch(/^ork-acme-prod-api-[0-9a-f]{6}$/);
    expect(() => moduleCall(ctx, request({ capability: 'https-load-balancer' }))).toThrow(/not implemented/);
  });
});

describe('GcpAdapter', () => {
  it('renders a gcs backend whose state object matches the state store', () => {
    const a = adapterWith(fakeFetch().fetch);
    const config = a.rootConfig(ctx, request()) as {
      terraform: { backend: { gcs: { bucket: string; prefix: string } }; required_providers: Record<string, { version: string }> };
      provider: { google: { project: string; default_labels: Record<string, string> } };
      module: { resource: { source: string } };
    };
    expect(config.terraform.backend.gcs).toEqual({ bucket: 'acme-orkstage-state', prefix: stateKeyFor('ork-acme-prod-api') });
    expect(gcsObjectName(stateKeyFor('ork-acme-prod-api'))).toBe('orkstage/ork-acme-prod-api.tfstate/default.tfstate');
    expect(gcsObjectName(`${stateKeyFor('x')}.config.json`)).toBe('orkstage/x.tfstate.config.json');
    expect(config.terraform.required_providers.google!.version).toBe('~> 8.0');
    expect(config.provider.google).toMatchObject({ project: 'acme-prod-123', default_labels: { platform_managed: 'true', platform_environment: 'production' } });
    expect(config.module.resource.source).toBe('/modules/gcp/container-service');
  });

  it('applies with the key only in the runner environment and stores the config in GCS', async () => {
    const f = fakeFetch((url, init) => (url.pathname.startsWith('/upload/storage/v1/b/acme-orkstage-state/o') && init.method === 'POST' ? { status: 200, body: {} } : undefined));
    const runner = fakeRunner();
    const result = await adapterWith(f.fetch, runner).ensureResource(ctx, request());
    expect(result.providerResourceId).toBe('projects/acme-prod-123/locations/us-central1/services/ork-acme-prod-api');
    const stack = vi.mocked(runner.apply).mock.calls[0]![0];
    expect(stack.env).toEqual({ GOOGLE_CREDENTIALS: keyJson });
    expect(JSON.stringify(stack.config)).not.toContain('PRIVATE KEY');
    const upload = f.calls.find((c) => c.url.includes('/upload/'))!;
    expect(new URL(upload.url).searchParams.get('name')).toBe('orkstage/ork-acme-prod-api.tfstate.config.json');
    expect(upload.auth).toBe('Bearer ya29.test');
    expect(upload.body).not.toContain('PRIVATE KEY');
  });

  it('reads state from the object the gcs backend writes', async () => {
    const state = { resources: [{ mode: 'managed' }], outputs: { all: { value: { kind: 'object-storage', bucket: 'b1' } } } };
    const f = fakeFetch((url) =>
      url.pathname === `/storage/v1/b/acme-orkstage-state/o/${encodeURIComponent('orkstage/ork-acme-prod-files.tfstate/default.tfstate')}` ? { status: 200, body: state } : undefined,
    );
    const a = adapterWith(f.fetch);
    const id = { resourceId: 'files', serviceKind: 'object-storage', capability: 'gcs', name: 'ork-acme-prod-files' };
    expect(await a.getResource(ctx, id)).toEqual({ exists: true, outputs: { kind: 'object-storage', bucket: 'b1' } });
    expect(await a.getResource(ctx, { ...id, name: 'missing' })).toEqual({ exists: false, outputs: {} });
  });

  it('answers the built in ingress without a runner', async () => {
    const f = fakeFetch((url, init) => (init.method === 'POST' && url.pathname.startsWith('/upload/') ? { status: 200, body: {} } : undefined));
    const r = await adapterWith(f.fetch).ensureResource(ctx, request({ serviceKind: 'ingress', capability: 'cloud-run-ingress', spec: { routes: [{ service: 'api', pathPrefix: '/' }] } }));
    expect(r.outputs).toEqual({ kind: 'ingress', mode: 'cloud-run', services: 'api' });
  });

  it('validates identity, state bucket and enabled APIs', async () => {
    const f = fakeFetch(
      (url) => (url.hostname === 'cloudresourcemanager.googleapis.com' ? { status: 200, body: { name: 'projects/42', projectId: 'acme-prod-123', state: 'ACTIVE' } } : undefined),
      (url) => (url.pathname === '/storage/v1/b/acme-orkstage-state' ? { status: 200, body: { name: 'acme-orkstage-state' } } : undefined),
      (url) =>
        url.hostname === 'serviceusage.googleapis.com'
          ? { status: 200, body: { services: url.searchParams.getAll('names').filter((n) => !n.endsWith('/redis.googleapis.com')).map((n) => ({ name: n.replace('acme-prod-123', '42'), state: 'ENABLED' })) } }
          : undefined,
    );
    const a = adapterWith(f.fetch);
    const res = await a.validateTarget(ctx, { serviceKinds: ['compute.container-service'] });
    expect(res.checks.map((c) => [c.name, c.status])).toEqual([
      ['Project access', 'ok'],
      ['State storage', 'ok'],
      ['APIs', 'warn'],
      ['Provisioning runner', 'skipped'],
    ]);
    expect(res).toMatchObject({ ok: true, identity: 'acme-prod-123' });
    const strict = await a.validateTarget(ctx, { serviceKinds: ['cache.redis'] });
    expect(strict.ok).toBe(false);
    expect(strict.checks.find((c) => c.name === 'APIs')!.message).toContain('gcloud services enable redis.googleapis.com');
  });

  it('signs a verifiable assertion and reports a project it cannot read', async () => {
    const jwt = signAssertion(key, 1000);
    const [h, c, s] = jwt.split('.');
    expect(createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(s!, 'base64url'))).toBe(true);
    expect(JSON.parse(Buffer.from(c!, 'base64url').toString())).toMatchObject({ iss: key.client_email, aud: 'https://oauth2.googleapis.com/token', exp: 4600 });

    const f = fakeFetch((url) => (url.hostname === 'cloudresourcemanager.googleapis.com' ? { status: 403, body: { error: { message: 'denied for deployer@acme-prod-123.iam.gserviceaccount.com' } } } : undefined));
    const res = await adapterWith(f.fetch).validateTarget(ctx);
    expect(res.ok).toBe(false);
    expect(res.checks[0]).toMatchObject({ name: 'Project access', status: 'error' });
    expect(JSON.stringify(res)).not.toContain('deployer@');
  });

  it('reports Cloud Run, Cloud SQL and Memorystore health, and 404 as gone', async () => {
    const f = fakeFetch(
      (url) => (url.hostname === 'run.googleapis.com' ? { status: 200, body: { terminalCondition: { type: 'Ready', state: 'CONDITION_SUCCEEDED' } } } : undefined),
      (url) => (url.hostname === 'api-xyz-uc.a.run.app' ? { status: 200, body: 'ok' } : undefined),
      (url) => (url.hostname === 'sqladmin.googleapis.com' ? { status: 200, body: { state: 'MAINTENANCE' } } : undefined),
    );
    const a = adapterWith(f.fetch);
    const svc = { resourceId: 'api', serviceKind: 'compute.container-service', capability: 'cloud-run', name: 'ork-acme-prod-api', outputs: { service_id: 'projects/acme-prod-123/locations/us-central1/services/ork-acme-prod-api', url: 'https://api-xyz-uc.a.run.app' } };
    expect((await a.checkHealth(ctx, svc)).state).toBe('HEALTHY');
    const db = { resourceId: 'db', serviceKind: 'database.postgresql', capability: 'cloud-sql-postgres', name: 'ork-acme-prod-db', outputs: { instance_name: 'ork-acme-prod-db-1a2b' } };
    expect(await a.checkHealth(ctx, db)).toMatchObject({ state: 'DEGRADED', message: 'Cloud SQL MAINTENANCE' });
    const cache = { resourceId: 'cache', serviceKind: 'cache.redis', capability: 'memorystore-redis', name: 'ork-acme-prod-cache', outputs: { instance_id: 'projects/acme-prod-123/locations/us-central1/instances/ork-acme-prod-cache' } };
    expect((await a.checkHealth(ctx, cache)).state).toBe('UNHEALTHY');
    const state = { resources: [{ mode: 'managed' }], outputs: { all: { value: cache.outputs } } };
    const g = fakeFetch((url) => (url.pathname.endsWith(encodeURIComponent('/default.tfstate')) ? { status: 200, body: state } : undefined));
    expect(await adapterWith(g.fetch).probeExists(ctx, cache)).toBe(false);
  });

  it('reads a Secret Manager secret as fields', async () => {
    const payload = Buffer.from(JSON.stringify({ username: 'app', password: 'pw', port: 5432 })).toString('base64');
    const f = fakeFetch((url) =>
      url.pathname === '/v1/projects/acme-prod-123/secrets/db-credentials/versions/latest:access' ? { status: 200, body: { payload: { data: payload } } } : undefined,
    );
    const a = adapterWith(f.fetch);
    expect(await a.readSecret(ctx, 'projects/acme-prod-123/secrets/db-credentials')).toEqual({ username: 'app', password: 'pw', port: '5432' });
    await expect(a.readSecret(ctx, 'arn:aws:x')).rejects.toMatchObject({ code: 'GCP_SECRET_REF_INVALID' });
  });

  it('redeploys a Cloud Run service with a forced new revision', async () => {
    const f = fakeFetch((url, init) =>
      url.hostname === 'run.googleapis.com'
        ? init.method === 'PATCH'
          ? { status: 200, body: { name: 'projects/acme-prod-123/locations/us-central1/operations/op-1' } }
          : { status: 200, body: { name: 'svc', template: { containers: [{ image: 'x' }] } } }
        : undefined,
    );
    const a = adapterWith(f.fetch);
    expect(a.actions('cloud-run').map((x) => x.name)).toEqual(['redeploy']);
    expect(a.actions('gcs')).toEqual([]);
    const res = await a.runAction(ctx, { resourceId: 'api', serviceKind: 'compute.container-service', capability: 'cloud-run', name: 'n', outputs: { service_id: 'projects/acme-prod-123/locations/us-central1/services/n' } }, { action: 'redeploy', params: {} });
    expect(res).toMatchObject({ status: 'started', reference: 'projects/acme-prod-123/locations/us-central1/operations/op-1' });
    const patch = f.calls.find((c) => c.method === 'PATCH')!;
    expect(new URL(patch.url).searchParams.get('forceNewRevision')).toBe('true');
  });

  it('reads Cloud Run logs from Cloud Logging', async () => {
    const f = fakeFetch((url) =>
      url.hostname === 'logging.googleapis.com'
        ? { status: 200, body: { entries: [{ timestamp: '2026-10-09T10:00:00Z', severity: 'ERROR', textPayload: 'boom' }, { timestamp: '2026-10-09T09:59:00Z', jsonPayload: { message: 'hello' } }] } }
        : undefined,
    );
    const lines = await adapterWith(f.fetch).getLogs(ctx, { resourceId: 'api', serviceKind: 'compute.container-service', capability: 'cloud-run', name: 'n', outputs: { service_name: 'n' } }, 10);
    expect(lines).toEqual([
      { timestamp: '2026-10-09T10:00:00Z', level: 'error', message: 'boom' },
      { timestamp: '2026-10-09T09:59:00Z', level: 'info', message: 'hello' },
    ]);
    expect(JSON.parse(f.calls.find((c) => c.url.includes('entries:list'))!.body!).filter).toContain('service_name="n"');
  });
});

describe('GcsStateStore', () => {
  it('treats missing objects as absent and deletes idempotently', async () => {
    const f = fakeFetch((_url, init) => (init.method === 'DELETE' ? { status: 404 } : undefined));
    const store = new GcsStateStore('bucket', async () => 't', f.fetch);
    expect(await store.get('orkstage/x.tfstate')).toBeNull();
    await expect(store.delete('orkstage/x.tfstate.config.json')).resolves.toBeUndefined();
    await expect(store.check()).rejects.toThrow('HTTP 404');
  });
});
