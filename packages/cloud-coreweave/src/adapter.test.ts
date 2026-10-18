// SPDX-License-Identifier: AGPL-3.0-only
import type { CloudTarget, ProviderContext, ResourceRequest } from '@orkstage/cloud-core';
import { runAdapterContract } from '@orkstage/cloud-core/testing';
import { stateKeyFor, type OpenTofuAdapterOptions, type StateStore } from '@orkstage/cloud-tofu';
import { FakeTofu, MemoryStateStore } from '@orkstage/cloud-tofu/testing';
import type { TofuRunner } from '@orkstage/iac';
import { describe, expect, it, vi } from 'vitest';
import { CoreWeaveAdapter } from './adapter.js';
import { COREWEAVE_CAPABILITIES } from './catalog.js';
import { coreweaveConfigChecks, labelsFrom, type CoreWeaveCredentials } from './config.js';
import { parseKubeconfig } from './kube.js';
import { gpuFrom, moduleCall, rootParts } from './stacks.js';

/** The real adapter with state kept in memory instead of AI Object Storage. */
class TestAdapter extends CoreWeaveAdapter {
  constructor(
    opts: OpenTofuAdapterOptions,
    readonly store = new MemoryStateStore(),
  ) {
    super(opts);
  }
  protected override stateStore(_ctx: ProviderContext, _creds: CoreWeaveCredentials): StateStore {
    return this.store;
  }
}

const TOKEN = 'CW-SECRET-test-token-value';
const SECRET = JSON.stringify({ token: TOKEN, stateAccessKeyId: 'CWAK1', stateSecretAccessKey: 'state-secret-value' });

const target: CloudTarget = {
  id: 't1',
  provider: 'coreweave',
  name: 'Acme GPU',
  config: { clusterName: 'gpu-east', zone: 'US-EAST-04A', stateBucket: 'acme-orkstage-state' },
  credentialRef: 'env://CW',
  allowedRegions: ['US-EAST-04A'],
  defaultRegion: 'US-EAST-04A',
};
const ctx: ProviderContext = { target, region: 'US-EAST-04A', correlationId: 'c1' };

const ingress = { kind: 'ingress', host: 'ork-acme-prod-edge.org1-gpu-east.coreweave.app', ingress_class: 'traefik', cluster_issuer: 'letsencrypt-prod', tls: true, routes: JSON.stringify({ api: '/api' }) };
const request = (over: Partial<ResourceRequest> = {}): ResourceRequest => ({
  resourceId: 'api',
  serviceKind: 'compute.container-service',
  capability: 'cks-deployment',
  name: 'ork-acme-prod-api',
  tags: { 'platform:managed': 'true', 'platform:environment': 'production' },
  spec: {
    image: 'ghcr.io/acme/infer@sha256:abc',
    cpu: 2,
    memoryMiB: 8192,
    replicas: 2,
    port: 8080,
    public: false,
    autoscaling: { minReplicas: 1, maxReplicas: 4, targetCpuPercent: 70 },
    providerOverrides: { coreweave: { gpu: { count: 1, class: 'H100_NVLINK_80GB' } } },
  },
  dependencyOutputs: {
    network: { kind: 'network', network_id: 'vpc-1' },
    edge: ingress,
    'orders-db': { kind: 'database.postgresql', host: 'db.example.com', port: 5432, secret_ref: 'arn:secret' },
  },
  idempotencyKey: 'k',
  ...over,
});

type Reply = { status: number; body?: unknown; text?: string };
type Handler = (url: URL, init: RequestInit) => Reply | undefined;

function fakeFetch(...handlers: Handler[]) {
  const calls: { method: string; url: string; body?: string; auth?: string; contentType?: string }[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({ method: init.method ?? 'GET', url: url.toString(), body: init.body as string | undefined, auth: headers.authorization, contentType: headers['content-type'] });
    for (const h of handlers) {
      const r = h(url, init);
      if (r) return new Response(r.text ?? (r.body === undefined ? '' : JSON.stringify(r.body)), { status: r.status });
    }
    throw new Error(`unexpected ${url}`);
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

const clusters: Handler = (u) =>
  u.pathname === '/v1beta1/cks/clusters'
    ? { status: 200, body: { items: [{ id: 'c-1', name: 'gpu-east', zone: 'US-EAST-04A', status: 'STATUS_RUNNING', apiServerEndpoint: 'abc.k8s.us-east-04a.coreweave.com' }] } }
    : undefined;
const whoami: Handler = (u) => (u.pathname === '/v1beta1/auth/whoami' ? { status: 200, body: { principal: { orgUid: 'org1', uid: 'u1' } } } : undefined);

function fakeRunner(outputs: Record<string, unknown> = {}) {
  return {
    apply: vi.fn().mockResolvedValue({ outputs: { all: outputs }, changes: { add: 3, change: 0, remove: 0 } }),
    plan: vi.fn().mockResolvedValue({ changes: { add: 0, change: 1, remove: 0 }, actions: [{ address: 'module.resource.kubernetes_secret_v1.deps', action: 'update' }] }),
    drift: vi.fn().mockResolvedValue([]),
    destroy: vi.fn().mockResolvedValue(undefined),
  } as unknown as TofuRunner;
}

describe('catalog', () => {
  it('offers network, containers, object storage and ingress, and leaves databases to other providers', () => {
    const kinds = COREWEAVE_CAPABILITIES.map((c) => c.serviceKind);
    expect(kinds).toEqual(['network', 'compute.container-service', 'object-storage', 'ingress']);
    expect(kinds).not.toContain('database.postgresql');
    expect(kinds).not.toContain('cache.redis');
    expect(COREWEAVE_CAPABILITIES.find((c) => c.capability === 'cks-deployment')?.features).toEqual(['gpu', 'autoscaling', 'public-ingress']);
  });
});

describe('config', () => {
  it('rejects bad buckets, zones and regions without calling CoreWeave', () => {
    const checks = coreweaveConfigChecks({ ...target, config: { stateBucket: 'cw-state', zone: 'us east' }, allowedRegions: ['us-east-1a'] });
    expect(checks.map((c) => c.name)).toEqual(['State bucket', 'Zone', 'Regions']);
    expect(coreweaveConfigChecks(target)).toEqual([]);
  });

  it('turns tags into valid labels', () => {
    expect(labelsFrom({ 'platform:managed': 'true', 'platform:owner': 'a b@c' })).toEqual({ platform_managed: 'true', platform_owner: 'a_b_c' });
  });
});

describe('stacks', () => {
  it('maps a GPU service with autoscaling and an ingress route', () => {
    const { module, inputs } = moduleCall(ctx, request());
    expect(module).toBe('container-service');
    expect(inputs).toMatchObject({
      name: 'ork-acme-prod-api',
      cpu_millicores: 2000,
      memory_mib: 8192,
      port: 8080,
      gpu: { count: 1, class: 'H100_NVLINK_80GB' },
      autoscaling: { min_replicas: 1, max_replicas: 4, target_cpu_percent: 70 },
      route: { host: ingress.host, path_prefix: '/api', ingress_class: 'traefik', tls: true, cluster_issuer: 'letsencrypt-prod' },
      environment: { ORDERS_DB_HOST: 'db.example.com', ORDERS_DB_PORT: '5432', PORT: '8080' },
      secret_env: '${var.secret_env}',
      labels: { platform_managed: 'true', platform_environment: 'production' },
    });
  });

  it('validates GPU overrides', () => {
    expect(gpuFrom({})).toBeNull();
    expect(() => gpuFrom({ providerOverrides: { coreweave: { gpu: { count: 16 } } } })).toThrow('1 to 8');
  });

  it('declares the kubernetes provider from variables only for cluster workloads', () => {
    const svc = rootParts(ctx, request());
    expect(Object.keys(svc.requiredProviders)).toEqual(['kubernetes']);
    expect(svc.providers.kubernetes).toEqual({ host: '${var.k8s_host}', token: '${var.k8s_token}', cluster_ca_certificate: '${var.k8s_ca == "" ? null : var.k8s_ca}' });
    expect(svc.variables).toMatchObject({ k8s_token: { sensitive: true }, secret_env: { type: 'map(string)', sensitive: true } });
    const bucket = rootParts(ctx, request({ serviceKind: 'object-storage', capability: 'ai-object-storage' }));
    expect(Object.keys(bucket.requiredProviders)).toEqual(['coreweave']);
    expect(bucket.variables).toEqual({});
    const edge = rootParts(ctx, request({ serviceKind: 'ingress', capability: 'cks-ingress' }));
    expect(Object.keys(edge.requiredProviders).sort()).toEqual(['coreweave', 'kubernetes']);
  });

  it('builds network, bucket and ingress inputs and rejects unknown capabilities', () => {
    expect(moduleCall(ctx, request({ serviceKind: 'network', capability: 'vpc', name: 'ork-acme-prod-net', spec: {} })).inputs).toMatchObject({ zone: 'US-EAST-04A', name: 'ork-acme-prod-net' });
    expect(moduleCall(ctx, request({ serviceKind: 'object-storage', capability: 'ai-object-storage', spec: { versioning: true, retentionDays: 30 } })).inputs).toMatchObject({ versioning: true, retention_days: 30, zone: 'US-EAST-04A' });
    expect(moduleCall(ctx, request({ serviceKind: 'ingress', capability: 'cks-ingress', spec: { routes: [{ service: 'api', pathPrefix: '/api' }], tls: true } })).inputs).toMatchObject({
      cluster_name: 'gpu-east',
      ingress_class: 'traefik',
      routes: '{"api":"/api"}',
    });
    expect(() => moduleCall(ctx, request({ serviceKind: 'database.postgresql', capability: 'managed-postgres' }))).toThrow('place api on another provider');
  });
});

describe('CoreWeaveAdapter', () => {
  it('uses a virtual hosted S3 backend on AI Object Storage', () => {
    const a = new TestAdapter({ resolveSecret: async () => SECRET });
    const config = a.rootConfig(ctx, request({ serviceKind: 'object-storage', capability: 'ai-object-storage', spec: {} })) as { terraform: { backend: { s3: Record<string, unknown> } } };
    expect(config.terraform.backend.s3).toMatchObject({
      bucket: 'acme-orkstage-state',
      key: stateKeyFor('ork-acme-prod-api'),
      region: 'US-EAST-04A',
      endpoints: { s3: 'https://cwobject.com' },
      use_path_style: false,
      use_lockfile: false,
    });
  });

  it('validates identity and the cluster', async () => {
    const { fn } = fakeFetch(whoami, clusters, (u) => (u.pathname === '/version' ? { status: 200, body: { gitVersion: 'v1.35.0' } } : undefined));
    const a = new TestAdapter({ resolveSecret: async () => SECRET, fetch: fn });
    const result = await a.validateTarget(ctx, { serviceKinds: ['compute.container-service'] });
    expect(result.checks.map((c) => [c.name, c.status])).toEqual([
      ['Organization access', 'ok'],
      ['State storage', 'ok'],
      ['CKS cluster', 'ok'],
      ['Provisioning runner', 'skipped'],
    ]);
    expect(result).toMatchObject({ ok: true, identity: 'org1' });
  });

  it('reports a rejected token and a missing cluster', async () => {
    const denied = fakeFetch((u) => (u.pathname === '/v1beta1/auth/whoami' ? { status: 401, text: 'unauthorized' } : undefined));
    const bad = await new TestAdapter({ resolveSecret: async () => SECRET, fetch: denied.fn }).validateTarget(ctx);
    expect(bad.checks[0]).toMatchObject({ name: 'Organization access', status: 'error' });
    const none = fakeFetch(whoami, (u) => (u.pathname === '/v1beta1/cks/clusters' ? { status: 200, body: { items: [] } } : undefined));
    const missing = await new TestAdapter({ resolveSecret: async () => SECRET, fetch: none.fn }).validateTarget(ctx, { serviceKinds: ['ingress'] });
    expect(missing.checks.find((c) => c.name === 'CKS cluster')).toMatchObject({ status: 'error' });
    expect(missing.ok).toBe(false);
  });

  it('passes cluster access and dependency credentials only as runner environment', async () => {
    const { fn, calls } = fakeFetch(clusters);
    const runner = fakeRunner({ kind: 'compute.container-service', service_id: 'ork-acme-prod-api/ork-acme-prod-api', namespace: 'ork-acme-prod-api', deployment: 'ork-acme-prod-api', url: 'https://x/api' });
    const a = new TestAdapter({ resolveSecret: async () => SECRET, fetch: fn, runner });
    const dependencySecret = vi.fn(async () => ({ password: 'db-password-value', username: 'app' }));
    const result = await a.ensureResource({ ...ctx, dependencySecret }, request());
    expect(result).toMatchObject({ providerResourceId: 'ork-acme-prod-api/ork-acme-prod-api', unchanged: false });
    expect(dependencySecret).toHaveBeenCalledWith('orders-db');
    const stack = vi.mocked(runner.apply).mock.calls[0]![0];
    expect(stack.env).toEqual({
      COREWEAVE_API_TOKEN: TOKEN,
      AWS_ACCESS_KEY_ID: 'CWAK1',
      AWS_SECRET_ACCESS_KEY: 'state-secret-value',
      TF_VAR_k8s_host: 'https://abc.k8s.us-east-04a.coreweave.com',
      TF_VAR_k8s_token: TOKEN,
      TF_VAR_k8s_ca: '',
      TF_VAR_secret_env: JSON.stringify({ ORDERS_DB_PASSWORD: 'db-password-value', ORDERS_DB_USERNAME: 'app' }),
    });
    const config = JSON.stringify(stack.config);
    for (const secret of [TOKEN, 'state-secret-value', 'db-password-value']) expect(config).not.toContain(secret);
    expect(calls.every((c) => c.auth === `Bearer ${TOKEN}`)).toBe(true);

    // The cluster endpoint is cached; a second run does not list clusters again.
    await a.ensureResource({ ...ctx, dependencySecret }, request());
    expect(calls.filter((c) => c.url.endsWith('/v1beta1/cks/clusters'))).toHaveLength(1);
  });

  it('runs buckets without cluster access and deletes from the stored config', async () => {
    const { fn, calls } = fakeFetch();
    const runner = fakeRunner({ kind: 'object-storage', bucket: 'ork-acme-prod-files-org1' });
    const a = new TestAdapter({ resolveSecret: async () => SECRET, fetch: fn, runner });
    const req = request({ resourceId: 'files', serviceKind: 'object-storage', capability: 'ai-object-storage', name: 'ork-acme-prod-files', spec: {}, dependencyOutputs: {} });
    expect((await a.ensureResource(ctx, req)).providerResourceId).toBe('ork-acme-prod-files-org1');
    expect(vi.mocked(runner.apply).mock.calls[0]![0].env).toMatchObject({ TF_VAR_k8s_host: '', TF_VAR_secret_env: '{}' });
    await a.deleteResource(ctx, { resourceId: 'files', serviceKind: 'object-storage', capability: 'ai-object-storage', name: 'ork-acme-prod-files' });
    expect(runner.destroy).toHaveBeenCalledOnce();
    expect(calls).toHaveLength(0);
  });

  it('fails clearly when a cluster workload has no cluster configured', async () => {
    const a = new TestAdapter({ resolveSecret: async () => SECRET, runner: fakeRunner() });
    const noCluster = { ...ctx, target: { ...target, config: { stateBucket: 'acme-orkstage-state' } } };
    await expect(a.ensureResource(noCluster, request())).rejects.toMatchObject({ code: 'COREWEAVE_CLUSTER_MISSING' });
  });

  it('reads deployment health from the Kubernetes API', async () => {
    const outputs = { kind: 'compute.container-service', namespace: 'ns1', deployment: 'api', url: 'https://edge.example.com/api' };
    const deployment = (available: number) => (u: URL) =>
      u.pathname === '/apis/apps/v1/namespaces/ns1/deployments/api' ? { status: 200, body: { spec: { replicas: 2 }, status: { availableReplicas: available } } } : undefined;
    const id = { resourceId: 'api', serviceKind: 'compute.container-service', capability: 'cks-deployment', name: 'ork-acme-prod-api', outputs };
    const healthy = new TestAdapter({ resolveSecret: async () => SECRET, fetch: fakeFetch(clusters, deployment(2)).fn });
    expect(await healthy.checkHealth(ctx, id)).toMatchObject({ state: 'HEALTHY', message: '2/2 replica(s) available' });
    const degraded = new TestAdapter({ resolveSecret: async () => SECRET, fetch: fakeFetch(clusters, deployment(1)).fn });
    expect((await degraded.checkHealth(ctx, id)).state).toBe('DEGRADED');

    // Kubernetes API unreachable (private endpoint): fall back to the public URL.
    const fallback = fakeFetch(clusters, (u) => {
      if (u.host === 'abc.k8s.us-east-04a.coreweave.com') throw new TypeError('fetch failed');
      return u.host === 'edge.example.com' ? { status: 200, text: 'ok' } : undefined;
    });
    const h = await new TestAdapter({ resolveSecret: async () => SECRET, fetch: fallback.fn }).checkHealth(ctx, id);
    expect(h.state).toBe('HEALTHY');
    expect(h.message).toContain('Kubernetes API unreachable');
  });

  it('probes existence: 404 means gone', async () => {
    const a = new TestAdapter({ resolveSecret: async () => SECRET, fetch: fakeFetch(clusters, (u) => (u.pathname.startsWith('/apis/apps') ? { status: 404, text: 'not found' } : undefined), (u) => (u.pathname.startsWith('/v1beta1/networking/vpcs/') ? { status: 200, body: { vpc: { name: 'n' } } } : undefined)).fn });
    a.store.objects.set(stateKeyFor('svc'), JSON.stringify({ resources: [{ mode: 'managed' }], outputs: { all: { value: { namespace: 'ns1', deployment: 'api' } } } }));
    a.store.objects.set(stateKeyFor('net'), JSON.stringify({ resources: [{ mode: 'managed' }], outputs: { all: { value: { network_id: 'vpc-1' } } } }));
    expect(await a.probeExists(ctx, { resourceId: 'api', serviceKind: 'compute.container-service', capability: 'cks-deployment', name: 'svc' })).toBe(false);
    expect(await a.probeExists(ctx, { resourceId: 'net', serviceKind: 'network', capability: 'vpc', name: 'net' })).toBe(true);
  });

  it('restarts a deployment with a pod template annotation', async () => {
    const { fn, calls } = fakeFetch(clusters, (u, init) => (init.method === 'PATCH' && u.pathname === '/apis/apps/v1/namespaces/ns1/deployments/api' ? { status: 200, body: {} } : undefined));
    const a = new TestAdapter({ resolveSecret: async () => SECRET, fetch: fn });
    expect(a.actions('cks-deployment').map((x) => x.name)).toEqual(['restart']);
    expect(a.actions('ai-object-storage')).toEqual([]);
    const r = await a.runAction(ctx, { resourceId: 'api', serviceKind: 'compute.container-service', capability: 'cks-deployment', name: 'svc', outputs: { namespace: 'ns1', deployment: 'api' } }, { action: 'restart', params: {} });
    expect(r.status).toBe('started');
    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(patch.contentType).toBe('application/strategic-merge-patch+json');
    expect(JSON.parse(patch.body!).spec.template.metadata.annotations['kubectl.kubernetes.io/restartedAt']).toBe(r.reference);
    await expect(a.runAction(ctx, { resourceId: 'api', serviceKind: 'compute.container-service', capability: 'cks-deployment', name: 'svc', outputs: { namespace: 'ns1', deployment: 'api' } }, { action: 'redeploy', params: {} })).rejects.toMatchObject({ code: 'COREWEAVE_ACTION_UNSUPPORTED' });
  });

  it('reads pod logs', async () => {
    const { fn } = fakeFetch(
      clusters,
      (u) => (u.pathname === '/api/v1/namespaces/ns1/pods' ? { status: 200, body: { items: [{ metadata: { name: 'api-1' } }] } } : undefined),
      (u) => (u.pathname === '/api/v1/namespaces/ns1/pods/api-1/log' ? { status: 200, text: '2026-10-10T10:00:00Z started\n2026-10-10T10:00:01Z ERROR boom\n' } : undefined),
    );
    const a = new TestAdapter({ resolveSecret: async () => SECRET, fetch: fn });
    const lines = await a.getLogs(ctx, { resourceId: 'api', serviceKind: 'compute.container-service', capability: 'cks-deployment', name: 'svc', outputs: { namespace: 'ns1', deployment: 'api' } }, 10);
    expect(lines.map((l) => [l.level, l.message])).toEqual([
      ['info', 'started'],
      ['error', 'ERROR boom'],
    ]);
  });

  it('uses a kubeconfig from the credential secret when present', async () => {
    const kubeconfig = Buffer.from(KUBECONFIG).toString('base64');
    const runner = fakeRunner({ kind: 'ingress', namespace: 'edge' });
    const a = new TestAdapter({ resolveSecret: async () => JSON.stringify({ ...JSON.parse(SECRET), kubeconfig }), runner, fetch: fakeFetch().fn });
    await a.ensureResource(ctx, request({ resourceId: 'edge', serviceKind: 'ingress', capability: 'cks-ingress', spec: { routes: [{ service: 'api', pathPrefix: '/' }], tls: true } }));
    expect(vi.mocked(runner.apply).mock.calls[0]![0].env).toMatchObject({ TF_VAR_k8s_host: 'https://private.example.internal:6443', TF_VAR_k8s_token: 'kube-token', TF_VAR_k8s_ca: 'PEM' });
  });
});

const KUBECONFIG = `apiVersion: v1
clusters:
- cluster:
    certificate-authority-data: ${Buffer.from('PEM').toString('base64')}
    server: https://private.example.internal:6443
  name: gpu-east
contexts:
- context:
    cluster: gpu-east
    namespace: default
    user: token
  name: gpu-east
current-context: gpu-east
kind: Config
preferences: {}
users:
- name: token
  user:
    token: kube-token
`;

describe('parseKubeconfig', () => {
  it('reads YAML, base64 and JSON kubeconfigs', () => {
    expect(parseKubeconfig(KUBECONFIG)).toEqual({ server: 'https://private.example.internal:6443', token: 'kube-token', ca: 'PEM' });
    expect(parseKubeconfig(Buffer.from(KUBECONFIG).toString('base64')).token).toBe('kube-token');
    const json = JSON.stringify({
      clusters: [{ name: 'a', cluster: { server: 'https://a' } }, { name: 'b', cluster: { server: 'https://b/' } }],
      contexts: [{ name: 'ctx-b', context: { cluster: 'b', user: 'ub' } }],
      users: [{ name: 'ub', user: { token: 't-b' } }],
      'current-context': 'ctx-b',
    });
    expect(parseKubeconfig(json)).toEqual({ server: 'https://b', token: 't-b', ca: undefined });
    expect(() => parseKubeconfig('apiVersion: v1\nkind: Config\n')).toThrow('no cluster server');
  });
});

/**
 * Contract fixture: state in memory, a fake OpenTofu writing to the same store, and the CoreWeave
 * and Kubernetes APIs answering for the organization, the cluster and the VPCs it has applied.
 * There is no replacing request: nothing a request can change on a VPC or a bucket forces a new
 * one (the zone and the name, which pick the state, are the only inputs that would), and
 * workloads on the cluster are rolled out, not replaced.
 */
runAdapterContract('CoreWeaveAdapter', () => {
  const store = new MemoryStateStore();
  const { fn } = fakeFetch(whoami, clusters, (u) => {
    if (u.pathname === '/version') return { status: 200, body: { gitVersion: 'v1.35.0' } };
    const vpc = /^\/v1beta1\/networking\/vpcs\/([^/]+)$/.exec(u.pathname)?.[1];
    if (vpc === undefined) return undefined;
    return tofu.isLive('network_id', decodeURIComponent(vpc)) ? { status: 200, body: { vpc: { id: vpc } } } : { status: 404, text: 'not found' };
  });
  const tofu = new FakeTofu({
    state: store,
    outputs: (inputs) => ({ kind: 'network', network_id: `vpc-${String(inputs.name)}`, name: String(inputs.name), zone: String(inputs.zone), pod_cidr: String(inputs.pod_cidr) }),
  });
  return {
    adapter: new TestAdapter({ resolveSecret: async () => SECRET, fetch: fn, runner: tofu.runner }, store),
    context: ctx,
    sampleRequest: request({ resourceId: 'net', serviceKind: 'network', capability: 'vpc', name: 'ork-acme-prod-net', spec: {}, dependencyOutputs: {} }),
    secrets: [TOKEN, 'state-secret-value'],
  };
});
