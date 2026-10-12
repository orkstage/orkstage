// SPDX-License-Identifier: AGPL-3.0-only
import { generateKeyPairSync } from 'node:crypto';
import type { CloudTarget, ProviderContext, ResourceRequest } from '@orkstage/cloud-core';
import { stateKeyFor, type StateStore } from '@orkstage/cloud-tofu';
import type { TofuRunner } from '@orkstage/iac';
import { describe, expect, it, vi } from 'vitest';
import { OciAdapter } from './adapter.js';
import { OCI_CAPABILITIES } from './catalog.js';
import { configChecks } from './config.js';
import { containerShape, freeformTags, moduleCall } from './stacks.js';

const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const secret = JSON.stringify({ privateKey: pem, stateAccessKeyId: 'AKIDOCI', stateSecretAccessKey: 'state-secret-value' });

const target: CloudTarget = {
  id: 't1',
  provider: 'oci',
  name: 'Acme OCI',
  config: {
    tenancyOcid: 'ocid1.tenancy.oc1..aaaatenancy',
    userOcid: 'ocid1.user.oc1..aaaauser',
    fingerprint: '20:3b:97:13:55:1c:5b:0d:d3:37:d8:50:4e:c5:3a:34',
    compartmentOcid: 'ocid1.compartment.oc1..aaaacompartment',
    namespace: 'axabc123',
    stateBucket: 'orkstage-state',
  },
  credentialRef: 'env://OCI',
  allowedRegions: ['us-ashburn-1', 'sa-saopaulo-1'],
  defaultRegion: 'us-ashburn-1',
};
const ctx: ProviderContext = { target, region: 'us-ashburn-1', correlationId: 'c1' };
const withConfig = (extra: Record<string, unknown>): ProviderContext => ({ ...ctx, target: { ...target, config: { ...target.config, ...extra } } });

const network = { kind: 'network', network_id: 'ocid1.vcn.oc1.iad.v', vcn_id: 'ocid1.vcn.oc1.iad.v', cidr: '10.20.0.0/16', public_subnet_id: 'pub', private_subnet_id: 'priv', private_egress: false };
const request = (over: Partial<ResourceRequest>): ResourceRequest => ({
  resourceId: 'api',
  serviceKind: 'compute.container-service',
  capability: 'container-instances',
  name: 'ork-acme-prod-api',
  tags: { 'platform:managed': 'true', 'platform:environment': 'production' },
  spec: { image: 'ghcr.io/acme/api@sha256:abc', cpu: 0.5, memoryMiB: 1024, replicas: 2, port: 8080, public: true },
  dependencyOutputs: { network },
  idempotencyKey: 'k',
  ...over,
});

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

class TestAdapter extends OciAdapter {
  readonly store = new MemoryStore();
  protected override stateStore() {
    return this.store;
  }
}

type Route = [RegExp, (url: string, init: RequestInit) => Response];
function fakeFetch(routes: Route[]) {
  return vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const found = routes.find(([re]) => re.test(url));
    return found ? found[1](url, init) : new Response('{"code":"NotAuthorizedOrNotFound"}', { status: 404 });
  });
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });

function fakeRunner() {
  return {
    apply: vi.fn().mockResolvedValue({ outputs: { all: { kind: 'compute.container-service', service_id: 'ocid1.computecontainerinstance.oc1.iad.a' } }, changes: { add: 1, change: 0, remove: 0 } }),
    plan: vi.fn().mockResolvedValue({ changes: { add: 1, change: 0, remove: 1 }, actions: [{ address: 'module.resource.oci_container_instances_container_instance.this[0]', action: 'replace' }] }),
    drift: vi.fn().mockResolvedValue([]),
    destroy: vi.fn().mockResolvedValue(undefined),
  } as unknown as TofuRunner;
}

describe('OCI target configuration', () => {
  it('accepts a complete configuration', () => {
    expect(configChecks(target)).toEqual([]);
  });

  it('reports each malformed field without calling OCI', async () => {
    const fetchFn = fakeFetch([]);
    const a = new OciAdapter({ resolveSecret: async () => secret, fetch: fetchFn as unknown as typeof fetch });
    const bad = await a.validateTarget({
      ...ctx,
      target: { ...target, allowedRegions: ['us-ashburn-1', 'us-east-1a'], config: { tenancyOcid: 'x', userOcid: 'y', fingerprint: 'z', compartmentOcid: 'c', namespace: 'NS!', stateBucket: '', vaultOcid: 'ocid1.vault.oc1.iad.b.a' } },
    });
    expect(bad.ok).toBe(false);
    expect(bad.checks.map((c) => c.name)).toEqual(['Tenancy', 'API user', 'API key fingerprint', 'Compartment', 'Object Storage namespace', 'State bucket', 'Vault', 'Regions']);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('OciAdapter.validateTarget', () => {
  it('confirms the compartment with a signed request and warns about the missing vault', async () => {
    const fetchFn = fakeFetch([[/identity\.us-ashburn-1\.oci\.oraclecloud\.com\/20160918\/compartments\/ocid1\.compartment/, () => json({ name: 'acme-prod', lifecycleState: 'ACTIVE' })]]);
    const a = new TestAdapter({ resolveSecret: async () => secret, fetch: fetchFn as unknown as typeof fetch });
    const result = await a.validateTarget(ctx);
    expect(result).toMatchObject({ ok: true, identity: 'acme-prod' });
    expect(result.checks.map((c) => [c.name, c.status])).toEqual([
      ['Compartment access', 'ok'],
      ['State storage', 'ok'],
      ['Vault for database credentials', 'warn'],
      ['Provisioning runner', 'skipped'],
    ]);
    const headers = (fetchFn.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers.authorization).toContain('keyId="ocid1.tenancy.oc1..aaaatenancy/ocid1.user.oc1..aaaauser/20:3b');
    const shared = await a.validateTarget(withConfig({ vaultOcid: 'ocid1.vault.oc1.iad.b.aaaa', keyOcid: 'ocid1.key.oc1.iad.b.aaaa' }));
    expect(shared.checks.some((c) => c.status === 'warn')).toBe(false);
    const noDb = await a.validateTarget(ctx, { serviceKinds: ['object-storage'] });
    expect(noDb.checks.some((c) => c.status === 'warn')).toBe(false);
  });

  it('explains a rejected signature', async () => {
    const fetchFn = fakeFetch([[/compartments/, () => json({ code: 'NotAuthenticated' }, 401)]]);
    const a = new TestAdapter({ resolveSecret: async () => secret, fetch: fetchFn as unknown as typeof fetch });
    const result = await a.validateTarget(ctx);
    expect(result.ok).toBe(false);
    expect(result.checks[0]).toMatchObject({ name: 'Compartment access', status: 'error' });
    expect(result.checks[0]!.message).toMatch(/fingerprint and privateKey/);
  });

  it('reports incomplete credentials', async () => {
    const a = new TestAdapter({ resolveSecret: async () => JSON.stringify({ privateKey: pem }) });
    const result = await a.validateTarget(ctx);
    expect(result.checks[0]).toMatchObject({ name: 'Credentials', status: 'error' });
    expect(result.checks[0]!.message).toContain('stateAccessKeyId, stateSecretAccessKey');
  });
});

describe('OpenTofu configuration', () => {
  it('passes the private key only as a sensitive variable and the state keys only as env', async () => {
    const runner = fakeRunner();
    const a = new TestAdapter({ resolveSecret: async () => secret, runner });
    await a.ensureResource(ctx, request({}));
    const stack = vi.mocked(runner.apply).mock.calls[0]![0];
    const config = stack.config as {
      terraform: { required_providers: Record<string, { source: string }>; backend: { s3: Record<string, unknown> } };
      variable: Record<string, { sensitive: boolean }>;
      provider: { oci: Record<string, string> };
      module: { resource: { source: string } };
    };
    expect(config.provider.oci).toEqual({
      tenancy_ocid: 'ocid1.tenancy.oc1..aaaatenancy',
      user_ocid: 'ocid1.user.oc1..aaaauser',
      fingerprint: '20:3b:97:13:55:1c:5b:0d:d3:37:d8:50:4e:c5:3a:34',
      region: 'us-ashburn-1',
      private_key: '${var.oci_private_key}',
    });
    expect(config.variable.oci_private_key!.sensitive).toBe(true);
    expect(config.terraform.required_providers.oci!.source).toBe('oracle/oci');
    expect(config.terraform.backend.s3).toMatchObject({
      bucket: 'orkstage-state',
      key: stateKeyFor('ork-acme-prod-api'),
      region: 'us-ashburn-1',
      endpoints: { s3: 'https://axabc123.compat.objectstorage.us-ashburn-1.oraclecloud.com' },
      use_path_style: true,
      use_lockfile: false,
    });
    expect(config.module.resource.source).toBe('/modules/oci/container-service');
    expect(stack.env).toEqual({ AWS_ACCESS_KEY_ID: 'AKIDOCI', AWS_SECRET_ACCESS_KEY: 'state-secret-value', TF_VAR_oci_private_key: pem });
    const text = JSON.stringify(stack.config);
    expect(text).not.toContain('PRIVATE KEY');
    expect(text).not.toContain('state-secret-value');
  });

  it('treats replaced container instances as a routine rollout', async () => {
    const a = new TestAdapter({ resolveSecret: async () => secret, runner: fakeRunner() });
    expect((await a.planResource(ctx, request({}))).destructive).toBe(false);
  });
});

describe('module inputs', () => {
  it('builds a network with a deterministic CIDR and DNS label', () => {
    const { module, inputs } = moduleCall(ctx, request({ serviceKind: 'network', capability: 'vcn', name: 'ork-acme-prod-net', spec: { natGateway: true }, dependencyOutputs: {} }));
    expect(module).toBe('network');
    expect(inputs.cidr).toMatch(/^10\.\d+\.0\.0\/16$/);
    expect(inputs.dns_label).toMatch(/^v[0-9a-f]{14}$/);
    expect(inputs).toMatchObject({ compartment_id: 'ocid1.compartment.oc1..aaaacompartment', nat_gateway: true });
    expect(inputs.freeform_tags).toEqual({ platform_managed: 'true', platform_environment: 'production' });
  });

  it('maps a container service to instances, wiring secrets as references and the ingress backend set', () => {
    const { module, inputs } = moduleCall(
      ctx,
      request({
        dependencyOutputs: {
          network,
          web: { kind: 'ingress', load_balancer_id: 'ocid1.loadbalancer.oc1.iad.lb', backend_sets: JSON.stringify({ api: 'api' }) },
          'orders-db': { kind: 'database.postgresql', host: '10.20.128.5', port: 5432, secret_ref: 'ocid1.vaultsecret.oc1.iad.s' },
        },
      }),
    );
    expect(module).toBe('container-service');
    expect(inputs).toMatchObject({ ocpus: 1, memory_gbs: 1, replicas: 2, subnet_id: 'pub', assign_public_ip: true, load_balancer_id: 'ocid1.loadbalancer.oc1.iad.lb', backend_set_name: 'api' });
    expect(inputs.environment).toEqual({ ORDERS_DB_HOST: '10.20.128.5', ORDERS_DB_PORT: '5432', ORDERS_DB_CREDENTIALS_REF: 'ocid1.vaultsecret.oc1.iad.s', PORT: '8080' });
  });

  it('uses the private subnet when the network has NAT, and no backend without an ingress route', () => {
    const { inputs } = moduleCall(ctx, request({ dependencyOutputs: { network: { ...network, private_egress: true } } }));
    expect(inputs).toMatchObject({ subnet_id: 'priv', assign_public_ip: false, load_balancer_id: '', backend_set_name: '' });
  });

  it('sizes container shapes in whole OCPUs within memory limits', () => {
    expect(containerShape(0.25, 512)).toEqual({ ocpus: 1, memoryGbs: 1 });
    expect(containerShape(4, 8192)).toEqual({ ocpus: 2, memoryGbs: 8 });
    expect(containerShape(2, 200_000)).toEqual({ ocpus: 1, memoryGbs: 64 });
  });

  it('maps PostgreSQL size, high availability, backups and the target vault', () => {
    const spec = { version: '16', size: 'medium', highAvailability: 'zone-redundant', backup: { enabled: true, retentionDays: 14 } };
    const { module, inputs } = moduleCall(
      withConfig({ vaultOcid: 'ocid1.vault.oc1.iad.b.v', keyOcid: 'ocid1.key.oc1.iad.b.k' }),
      request({ serviceKind: 'database.postgresql', capability: 'oci-postgresql', spec }),
    );
    expect(module).toBe('postgres');
    expect(inputs).toMatchObject({ db_version: '16', ocpus: 4, memory_gbs: 64, instance_count: 2, backup_retention_days: 14, subnet_id: 'priv', vault_id: 'ocid1.vault.oc1.iad.b.v', key_id: 'ocid1.key.oc1.iad.b.k' });
    const plain = moduleCall(ctx, request({ serviceKind: 'database.postgresql', capability: 'oci-postgresql', spec: { backup: { enabled: false } } })).inputs;
    expect(plain).toMatchObject({ instance_count: 1, backup_retention_days: 0, vault_id: '', key_id: '', ocpus: 2 });
  });

  it('maps cache, bucket and load balancer inputs', () => {
    expect(moduleCall(ctx, request({ serviceKind: 'cache.redis', capability: 'oci-cache', spec: { size: 'small', replicas: 9 } })).inputs).toMatchObject({ node_memory_gbs: 4, node_count: 5, subnet_id: 'priv' });
    expect(moduleCall(ctx, request({ serviceKind: 'object-storage', capability: 'object-storage', spec: { tier: 'archive', versioning: true, retentionDays: 30 }, dependencyOutputs: {} })).inputs).toMatchObject({
      namespace: 'axabc123',
      region: 'us-ashburn-1',
      tier: 'archive',
      versioning: true,
      retention_days: 30,
      public_access: false,
    });
    const ingress = moduleCall(ctx, request({ serviceKind: 'ingress', capability: 'flexible-load-balancer', spec: { routes: [{ service: 'api', pathPrefix: '/api' }, { service: 'web' }] } })).inputs;
    expect(ingress).toMatchObject({ subnet_id: 'pub', production: true, routes: [{ service: 'api', path_prefix: '/api', health_path: '/' }, { service: 'web', path_prefix: '/', health_path: '/' }] });
  });

  it('rejects unknown capabilities and missing networks', () => {
    expect(() => moduleCall(ctx, request({ capability: 'oke' }))).toThrow(/not implemented/);
    expect(() => moduleCall(ctx, request({ dependencyOutputs: {} }))).toThrow(/needs a network/);
  });

  it('sanitizes tag keys', () => {
    expect(freeformTags({ 'platform:instance': 'a b', 'x.y': 'z' })).toEqual({ platform_instance: 'a b', x_y: 'z' });
  });
});

describe('health, existence, secrets and actions', () => {
  const service = { kind: 'compute.container-service', service_id: 'ocid1.computecontainerinstance.oc1.iad.a', instance_ids: 'ocid1.computecontainerinstance.oc1.iad.a,ocid1.computecontainerinstance.oc1.iad.b' };
  const id = (serviceKind: string, capability: string, outputs: Record<string, string | number | boolean>) => ({ resourceId: 'api', serviceKind, capability, name: 'n1', outputs });

  it('counts active container instances', async () => {
    const fetchFn = fakeFetch([
      [/containerInstances\/ocid1\.computecontainerinstance\.oc1\.iad\.a$/, () => json({ lifecycleState: 'ACTIVE' })],
      [/containerInstances\/ocid1\.computecontainerinstance\.oc1\.iad\.b$/, () => json({ lifecycleState: 'CREATING' })],
    ]);
    const a = new TestAdapter({ resolveSecret: async () => secret, fetch: fetchFn as unknown as typeof fetch });
    const h = await a.checkHealth(ctx, id('compute.container-service', 'container-instances', service));
    expect(h).toMatchObject({ state: 'DEGRADED', message: '1/2 container instance(s) active' });
    expect(String(fetchFn.mock.calls[0]![0])).toMatch(/^https:\/\/compute-containers\.us-ashburn-1\.oci\.oraclecloud\.com\/20210415\//);
  });

  it('reads lifecycle states and checks the load balancer URL', async () => {
    const fetchFn = fakeFetch([
      [/postgresql\.us-ashburn-1\.oci\.oraclecloud\.com\/20220915\/dbSystems\/db1$/, () => json({ lifecycleState: 'ACTIVE' })],
      [/redis\.us-ashburn-1\.oci\.oraclecloud\.com\/20220315\/redisClusters\/c1$/, () => json({ lifecycleState: 'UPDATING' })],
      [/iaas\.us-ashburn-1\.oraclecloud\.com\/20170115\/loadBalancers\/lb1$/, () => json({ lifecycleState: 'ACTIVE' })],
      [/^http:\/\/203\.0\.113\.10\/$/, () => new Response('ok', { status: 200 })],
      [/objectstorage\.us-ashburn-1\.oraclecloud\.com\/n\/axabc123\/b\/files$/, () => json({ name: 'files' })],
    ]);
    const a = new TestAdapter({ resolveSecret: async () => secret, fetch: fetchFn as unknown as typeof fetch });
    expect((await a.checkHealth(ctx, id('database.postgresql', 'oci-postgresql', { id: 'db1' }))).state).toBe('HEALTHY');
    expect((await a.checkHealth(ctx, id('cache.redis', 'oci-cache', { id: 'c1' }))).state).toBe('DEGRADED');
    expect((await a.checkHealth(ctx, id('ingress', 'flexible-load-balancer', { load_balancer_id: 'lb1', url: 'http://203.0.113.10/' }))).message).toBe('HTTP 200 from 203.0.113.10');
    expect((await a.checkHealth(ctx, id('object-storage', 'object-storage', { bucket: 'files', namespace: 'axabc123' }))).state).toBe('HEALTHY');
  });

  it('probes existence: 404 or deleted is false, other failures unknown', async () => {
    const fetchFn = fakeFetch([
      [/dbSystems\/gone$/, () => json({ lifecycleState: 'DELETED' })],
      [/dbSystems\/broken$/, () => json({ code: 'InternalError' }, 500)],
    ]);
    const a = new TestAdapter({ resolveSecret: async () => secret, fetch: fetchFn as unknown as typeof fetch });
    const withState = (out: Record<string, string>) => {
      a.store.objects.set(stateKeyFor('n1'), JSON.stringify({ resources: [{ mode: 'managed' }], outputs: { all: { value: { kind: 'database.postgresql', ...out } } } }));
      return a.probeExists(ctx, id('database.postgresql', 'oci-postgresql', {}));
    };
    expect(await withState({ id: 'missing' })).toBe(false);
    expect(await withState({ id: 'gone' })).toBe(false);
    expect(await withState({ id: 'broken' })).toBeUndefined();
  });

  it('reads JSON credentials from a Vault secret bundle', async () => {
    const content = Buffer.from(JSON.stringify({ username: 'app', password: 'pw', host: '10.0.0.5', port: '5432', database: 'postgres', url: 'postgresql://app:pw@10.0.0.5:5432/postgres' })).toString('base64');
    const fetchFn = fakeFetch([[/secrets\.vaults\.us-ashburn-1\.oci\.oraclecloud\.com\/20190301\/secretbundles\/ocid1\.vaultsecret\.oc1\.iad\.s$/, () => json({ secretBundleContent: { contentType: 'BASE64', content } })]]);
    const a = new TestAdapter({ resolveSecret: async () => secret, fetch: fetchFn as unknown as typeof fetch });
    expect(await a.readSecret(ctx, 'ocid1.vaultsecret.oc1.iad.s')).toMatchObject({ username: 'app', password: 'pw', port: '5432', database: 'postgres' });
    await expect(a.readSecret(ctx, 'arn:aws:secretsmanager:x')).rejects.toMatchObject({ code: 'OCI_SECRET_REF_INVALID' });
    await expect(a.readSecret(ctx, 'ocid1.vaultsecret.oc1.iad.other')).rejects.toMatchObject({ code: 'OCI_SECRET_UNREADABLE', failureClass: 'VALIDATION_ERROR' });
  });

  it('restarts every container instance of a service', async () => {
    const fetchFn = fakeFetch([[/\/actions\/restart$/, () => new Response(null, { status: 202, headers: { 'opc-work-request-id': 'wr-1' } })]]);
    const a = new TestAdapter({ resolveSecret: async () => secret, fetch: fetchFn as unknown as typeof fetch });
    expect(a.actions('container-instances').map((x) => x.name)).toEqual(['restart']);
    expect(a.actions('oci-postgresql')).toEqual([]);
    const result = await a.runAction(ctx, id('compute.container-service', 'container-instances', service), { action: 'restart', params: {} });
    expect(result).toMatchObject({ status: 'started', reference: 'wr-1', message: 'Restart requested for 2 container instance(s).' });
    const calls = fetchFn.mock.calls.map((c) => [String(c[0]), (c[1] as RequestInit).method]);
    expect(calls).toEqual([
      ['https://compute-containers.us-ashburn-1.oci.oraclecloud.com/20210415/containerInstances/ocid1.computecontainerinstance.oc1.iad.a/actions/restart', 'POST'],
      ['https://compute-containers.us-ashburn-1.oci.oraclecloud.com/20210415/containerInstances/ocid1.computecontainerinstance.oc1.iad.b/actions/restart', 'POST'],
    ]);
    await expect(a.runAction(ctx, id('compute.container-service', 'container-instances', service), { action: 'redeploy', params: {} })).rejects.toMatchObject({ code: 'OCI_ACTION_NOT_SUPPORTED' });
  });

  it('reads container logs', async () => {
    const fetchFn = fakeFetch([
      [/containerInstances\/ocid1\.computecontainerinstance\.oc1\.iad\.a$/, () => json({ lifecycleState: 'ACTIVE', containers: [{ containerId: 'ctr-a' }] })],
      [/containers\/ctr-a\/actions\/retrieveLogs$/, () => new Response('started\nError: boom\n', { status: 200 })],
    ]);
    const a = new TestAdapter({ resolveSecret: async () => secret, fetch: fetchFn as unknown as typeof fetch });
    const lines = await a.getLogs(ctx, id('compute.container-service', 'container-instances', { ...service, instance_ids: 'ocid1.computecontainerinstance.oc1.iad.a' }), 10);
    expect(lines.map((l) => [l.level, l.message])).toEqual([
      ['info', 'started'],
      ['error', 'Error: boom'],
    ]);
  });
});

describe('catalog', () => {
  it('has one default per kind and OCI pricing notes', () => {
    const kinds = new Set(OCI_CAPABILITIES.map((c) => c.serviceKind));
    for (const kind of kinds) expect(OCI_CAPABILITIES.filter((c) => c.serviceKind === kind && c.isDefault)).toHaveLength(1);
    expect(OCI_CAPABILITIES.map((c) => c.capability)).toEqual(['vcn', 'container-instances', 'oci-postgresql', 'oci-cache', 'object-storage', 'flexible-load-balancer']);
    expect(OCI_CAPABILITIES.every((c) => c.pricing?.source.startsWith('Static OCI list prices'))).toBe(true);
  });
});
