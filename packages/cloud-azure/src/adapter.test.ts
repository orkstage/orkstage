// SPDX-License-Identifier: AGPL-3.0-only
import type { CloudTarget, ProviderContext, ResourceRequest } from '@orkstage/cloud-core';
import type { TofuRunner } from '@orkstage/iac';
import { describe, expect, it, vi } from 'vitest';
import { AzureAdapter } from './adapter.js';
import { AZURE_CAPABILITIES } from './catalog.js';
import { configChecks } from './config.js';
import { containerSize, globalName, isKeyVaultSecretId, moduleCall, storageAccountName } from './stacks.js';

const SUB = '0b1f6471-1bf0-4dda-aec3-111111111111';
const SECRET = 'very-secret-client-value';
const target: CloudTarget = {
  id: 't1',
  provider: 'azure',
  name: 'Acme Azure',
  config: {
    tenantId: '72f988bf-86f1-41af-91ab-2d7cd011db47',
    subscriptionId: SUB,
    clientId: '11111111-2222-3333-4444-555555555555',
    stateResourceGroup: 'orkstage-state',
    stateStorageAccount: 'orkstagestate01',
  },
  credentialRef: 'env://AZURE_ORKSTAGE',
  allowedRegions: ['eastus', 'brazilsouth'],
  defaultRegion: 'eastus',
};
const ctx: ProviderContext = { target, region: 'eastus', correlationId: 'c1' };

const APP_ID = `/subscriptions/${SUB}/resourceGroups/ork-acme-prod-api-rg/providers/Microsoft.App/containerApps/ork-acme-prod-api`;
const network = {
  kind: 'network',
  network_id: `/subscriptions/${SUB}/resourceGroups/n-rg/providers/Microsoft.Network/virtualNetworks/n`,
  postgres_subnet_id: 'subnet-pg',
  private_subnet_id: 'subnet-pe',
  redis_dns_zone_id: 'zone-redis',
  container_app_environment_id: 'env-1',
  log_workspace_id: '9d3c1a40-0000-4000-8000-000000000001',
};
const request = (over: Partial<ResourceRequest> = {}): ResourceRequest => ({
  resourceId: 'api',
  serviceKind: 'compute.container-service',
  capability: 'container-apps',
  name: 'ork-acme-prod-api',
  tags: { 'platform:managed': 'true', 'platform:environment': 'production' },
  spec: { image: 'ghcr.io/acme/api@sha256:abc', cpu: 0.5, memoryMiB: 512, replicas: 2, port: 8080, public: true, healthCheckPath: '/health' },
  dependencyOutputs: { network },
  idempotencyKey: 'k',
  ...over,
});

type Handler = (url: URL, init: RequestInit) => Response | undefined;

/** Fake fetch: answers token requests and routes everything else to `handlers`. */
function fakeFetch(handlers: Handler[] = []) {
  const calls: { url: string; method: string; headers: Record<string, string>; body?: string }[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url: url.toString(), method: init.method ?? 'GET', headers: (init.headers ?? {}) as Record<string, string>, body: typeof init.body === 'string' ? init.body : init.body?.toString() });
    if (url.host === 'login.microsoftonline.com') {
      const scope = new URLSearchParams(String(init.body)).get('scope');
      return Response.json({ access_token: `tok:${scope}`, expires_in: 3600 });
    }
    for (const h of handlers) {
      const r = h(url, init);
      if (r) return r;
    }
    return new Response('not found', { status: 404 });
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

const blobStore = (objects = new Map<string, string>()): Handler => (url, init) => {
  if (!url.host.endsWith('.blob.core.windows.net')) return undefined;
  if (url.searchParams.get('restype') === 'container') return new Response(null, { status: 200 });
  const key = decodeURIComponent(url.pathname.split('/').slice(2).join('/'));
  if (init.method === 'PUT') {
    objects.set(key, String(init.body));
    return new Response(null, { status: 201 });
  }
  if (init.method === 'DELETE') {
    const had = objects.delete(key);
    return new Response(null, { status: had ? 202 : 404 });
  }
  const v = objects.get(key);
  return v === undefined ? new Response('BlobNotFound', { status: 404 }) : new Response(v);
};

function fakeRunner() {
  return {
    apply: vi.fn().mockResolvedValue({ outputs: { all: { kind: 'compute.container-service', service_id: APP_ID, name: 'ork-acme-prod-api', url: 'https://api.example.io' } }, changes: { add: 3, change: 0, remove: 0 } }),
    plan: vi.fn().mockResolvedValue({ changes: { add: 0, change: 0, remove: 0 }, actions: [{ address: 'module.resource.time_sleep.rbac[0]', action: 'replace' }] }),
    drift: vi.fn().mockResolvedValue([]),
    destroy: vi.fn().mockResolvedValue(undefined),
  } as unknown as TofuRunner;
}

describe('configuration', () => {
  it('accepts a complete target and reports each malformed field', () => {
    expect(configChecks(target)).toEqual([expect.objectContaining({ status: 'ok' })]);
    const bad = configChecks({ ...target, config: { tenantId: 'x', subscriptionId: SUB, clientId: 'y', stateResourceGroup: '', stateStorageAccount: 'Bad-Name', stateContainer: 'A' } });
    expect(bad.map((c) => c.name)).toEqual(['Tenant id', 'Client id', 'State resource group', 'State storage account', 'State container']);
  });

  it('publishes one default per kind and the expected capabilities', () => {
    const ids = AZURE_CAPABILITIES.map((c) => c.capability);
    expect(ids).toEqual(['vnet', 'container-apps', 'flexible-server', 'managed-redis', 'blob-storage', 'container-apps-ingress', 'front-door']);
    for (const kind of new Set(AZURE_CAPABILITIES.map((c) => c.serviceKind))) {
      expect(AZURE_CAPABILITIES.filter((c) => c.serviceKind === kind && c.isDefault)).toHaveLength(1);
    }
  });
});

describe('AzureAdapter.validateTarget', () => {
  it('proves the identity, checks the state container and resource providers, caching tokens', async () => {
    const { fetch, calls } = fakeFetch([
      blobStore(),
      (url) => (url.pathname === `/subscriptions/${SUB}` ? Response.json({ subscriptionId: SUB, displayName: 'Acme Production', state: 'Enabled' }) : undefined),
      (url) => (url.pathname === `/subscriptions/${SUB}/providers` ? Response.json({ value: [{ namespace: 'Microsoft.App', registrationState: 'Registered' }, { namespace: 'Microsoft.OperationalInsights', registrationState: 'Registered' }, { namespace: 'Microsoft.ManagedIdentity', registrationState: 'NotRegistered' }] }) : undefined),
    ]);
    const adapter = new AzureAdapter({ resolveSecret: async () => JSON.stringify({ clientSecret: SECRET }), fetch });
    const result = await adapter.validateTarget(ctx, { serviceKinds: ['compute.container-service'] });
    expect(result.identity).toBe('Acme Production');
    expect(result.checks.map((c) => [c.name, c.status])).toEqual([
      ['Target configuration', 'ok'],
      ['Subscription access', 'ok'],
      ['State storage', 'ok'],
      ['Resource providers', 'warn'],
      ['Provisioning runner', 'skipped'],
    ]);
    expect(result.ok).toBe(true);
    const tokenCalls = calls.filter((c) => c.url.includes('login.microsoftonline.com'));
    expect(tokenCalls).toHaveLength(2); // management (reused) and storage
    expect(calls.find((c) => c.url.includes('blob.core.windows.net'))?.headers['x-ms-version']).toBeTruthy();
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('reports a missing role on the subscription without leaking ids', async () => {
    const { fetch } = fakeFetch([(url) => (url.host === 'management.azure.com' ? new Response(`{"error":{"code":"AuthorizationFailed","message":"client 11111111-2222-3333-4444-555555555555 denied"}}`, { status: 403 }) : undefined)]);
    const adapter = new AzureAdapter({ resolveSecret: async () => SECRET, fetch });
    const result = await adapter.validateTarget(ctx);
    expect(result.ok).toBe(false);
    expect(result.checks.find((c) => c.name === 'Subscription access')).toMatchObject({ status: 'error', message: expect.stringContaining('no role') });
  });

  it('reports a rejected client secret', async () => {
    const fetch = vi.fn(async () => Response.json({ error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided.\r\nTrace ID: abc' }, { status: 401 })) as unknown as typeof globalThis.fetch;
    const adapter = new AzureAdapter({ resolveSecret: async () => SECRET, fetch });
    const result = await adapter.validateTarget(ctx);
    const check = result.checks.find((c) => c.name === 'Subscription access');
    expect(check?.status).toBe('error');
    expect(check?.message).toContain('invalid_client');
    expect(check?.message).not.toContain('Trace ID');
  });
});

describe('provisioning', () => {
  it('renders backend, provider and module without secrets, and passes credentials as ARM_* env', async () => {
    const objects = new Map<string, string>();
    const { fetch } = fakeFetch([blobStore(objects)]);
    const runner = fakeRunner();
    const adapter = new AzureAdapter({ resolveSecret: async () => JSON.stringify({ clientSecret: SECRET }), fetch, runner });
    const result = await adapter.ensureResource(ctx, request());
    expect(result.providerResourceId).toBe(APP_ID);
    const stack = vi.mocked(runner.apply).mock.calls[0]![0];
    expect(stack.env).toEqual({ ARM_TENANT_ID: target.config.tenantId, ARM_CLIENT_ID: target.config.clientId, ARM_CLIENT_SECRET: SECRET, ARM_SUBSCRIPTION_ID: SUB });
    const config = stack.config as {
      terraform: { backend: { azurerm: Record<string, unknown> }; required_providers: Record<string, { version: string }> };
      provider: { azurerm: { features: { resource_group: { prevent_deletion_if_contains_resources: boolean } }; resource_providers_to_register: string[] } };
      module: { resource: Record<string, unknown> };
    };
    expect(JSON.stringify(config)).not.toContain(SECRET);
    expect(config.terraform.backend.azurerm).toEqual({
      resource_group_name: 'orkstage-state',
      storage_account_name: 'orkstagestate01',
      container_name: 'orkstage-tfstate',
      key: 'orkstage/ork-acme-prod-api.tfstate',
      use_azuread_auth: true,
      use_cli: false,
    });
    expect(config.terraform.required_providers.azurerm!.version).toBe('~> 5.0');
    expect(config.provider.azurerm.features.resource_group.prevent_deletion_if_contains_resources).toBe(true);
    expect(config.provider.azurerm.resource_providers_to_register).toContain('Microsoft.App');
    expect(config.module.resource).toMatchObject({ source: '/modules/azure/container-service', location: 'eastus', resource_group_name: 'ork-acme-prod-api-rg' });
    expect((config.module.resource.tags as Record<string, string>)['platform:managed']).toBe('true');
    expect(objects.has('orkstage/ork-acme-prod-api.tfstate.config.json')).toBe(true);
  });

  it('treats waits for role propagation as routine in plans', async () => {
    const { fetch } = fakeFetch([blobStore()]);
    const adapter = new AzureAdapter({ resolveSecret: async () => SECRET, fetch, runner: fakeRunner() });
    expect((await adapter.planResource(ctx, request())).destructive).toBe(false);
  });

  it('answers the built in ingress without a runner and keeps the routes', async () => {
    const objects = new Map<string, string>();
    const { fetch } = fakeFetch([blobStore(objects)]);
    const adapter = new AzureAdapter({ resolveSecret: async () => SECRET, fetch });
    const req = request({ resourceId: 'edge', serviceKind: 'ingress', capability: 'container-apps-ingress', name: 'ork-acme-prod-edge', spec: { routes: [{ service: 'api', pathPrefix: '/api' }] } });
    const first = await adapter.ensureResource(ctx, req);
    expect(first.outputs).toMatchObject({ kind: 'ingress', mode: 'container-apps-builtin', routes: JSON.stringify([{ service: 'api', pathPrefix: '/api' }]) });
    expect((await adapter.ensureResource(ctx, req)).unchanged).toBe(true);
    const id = { resourceId: 'edge', serviceKind: 'ingress', capability: 'container-apps-ingress', name: 'ork-acme-prod-edge' };
    expect((await adapter.checkHealth(ctx, id)).state).toBe('HEALTHY');
    await adapter.deleteResource(ctx, id);
    expect(objects.size).toBe(0);
  });
});

describe('module inputs', () => {
  it('wires a container app to Key Vault secrets, storage, the shared environment and Front Door', () => {
    const vaultId = `/subscriptions/${SUB}/resourceGroups/db-rg/providers/Microsoft.KeyVault/vaults/ork-db-abc123`;
    const { module, inputs } = moduleCall(ctx, request({
      spec: { image: 'img', cpu: 0.25, memoryMiB: 2048, replicas: 1, port: 8080, public: true, autoscaling: { minReplicas: 1, maxReplicas: 5, targetCpuPercent: 70 } },
      dependencyOutputs: {
        network,
        'orders-db': { kind: 'database.postgresql', host: 'db.private.postgres.database.azure.com', port: 5432, secret_ref: 'https://ork-db-abc123.vault.azure.net/secrets/credentials', key_vault_id: vaultId },
        files: { kind: 'object-storage', bucket: 'files', endpoint: 'https://acct.blob.core.windows.net/', storage_account_id: 'sa-1' },
        cache: { kind: 'cache.redis', host: 'r', port: 10000, secret_ref: 'arn:aws:secretsmanager:x' },
        edge: { kind: 'ingress', origin_groups: JSON.stringify({ api: 'og-1' }) },
      },
    }));
    expect(module).toBe('container-service');
    expect(inputs).toMatchObject({
      name: 'ork-acme-prod-api',
      cpu: 1,
      memory: '2Gi',
      environment_id: 'env-1',
      origin_group_id: 'og-1',
      storage_account_ids: ['sa-1'],
      secrets: { ORDERS_DB_CREDENTIALS: { secret_id: 'https://ork-db-abc123.vault.azure.net/secrets/credentials', vault_id: vaultId } },
      autoscaling: { min_replicas: 1, max_replicas: 5, target_cpu_percent: 70 },
    });
    expect(inputs.environment).toMatchObject({ PORT: '8080', ORDERS_DB_HOST: 'db.private.postgres.database.azure.com', FILES_BUCKET: 'files', CACHE_CREDENTIALS_REF: 'arn:aws:secretsmanager:x' });
  });

  it('places PostgreSQL in the delegated subnet and upgrades burstable sizes for HA', () => {
    const warn = vi.fn();
    const { inputs } = moduleCall({ ...ctx, log: warn }, request({
      resourceId: 'db', serviceKind: 'database.postgresql', capability: 'flexible-server', name: 'ork-acme-prod-db',
      spec: { version: '17', size: 'small', storageGiB: 40, highAvailability: 'zone-redundant', publicAccess: false, backup: { enabled: true, retentionDays: 3 } },
    }));
    expect(inputs).toMatchObject({ sku_name: 'GP_Standard_D2ds_v5', storage_mb: 65536, high_availability: 'ZoneRedundant', backup_retention_days: 7, delegated_subnet_id: 'subnet-pg', vnet_id: network.network_id, production: true });
    expect(String(inputs.vault_name).length).toBeLessThanOrEqual(24);
    expect(warn).toHaveBeenCalledWith('warn', expect.stringContaining('General Purpose'));
    expect(() => moduleCall(ctx, request({ serviceKind: 'database.postgresql', capability: 'flexible-server', spec: { publicAccess: false }, dependencyOutputs: {} }))).toThrow(/needs a network/);
  });

  it('keeps global names unique and within Azure limits', () => {
    const long = 'ork-a-very-long-tenant-name-production-orders-db';
    expect(globalName(long, SUB, 24)).toMatch(/^[a-z0-9-]{1,17}-[0-9a-f]{6}$/);
    expect(globalName(long, SUB, 24)).not.toBe(globalName(long, '00000000-0000-0000-0000-000000000000', 24));
    expect(storageAccountName(long, SUB)).toMatch(/^[a-z0-9]{3,24}$/);
    expect(containerSize(0.25, 512)).toEqual({ cpu: 0.25, memory: '0.5Gi' });
    expect(containerSize(16, 512)).toEqual({ cpu: 4, memory: '8Gi' });
  });

  it('rejects implementations without a module', () => {
    expect(() => moduleCall(ctx, request({ capability: 'aks' }))).toThrow(/not implemented/);
  });
});

describe('operations', () => {
  const appOutputs = { kind: 'compute.container-service', service_id: APP_ID, name: 'ork-acme-prod-api', url: 'https://api.example.io', log_workspace_id: network.log_workspace_id };
  const ident = { resourceId: 'api', serviceKind: 'compute.container-service', capability: 'container-apps', name: 'ork-acme-prod-api', outputs: appOutputs };
  const armApp = (body: unknown): Handler => (url, init) =>
    url.host === 'management.azure.com' && url.pathname === APP_ID && (init.method ?? 'GET') === 'GET' ? Response.json(body) : undefined;

  it('checks container app state through ARM and the public URL', async () => {
    const { fetch } = fakeFetch([
      armApp({ properties: { provisioningState: 'Succeeded', runningStatus: 'Running' } }),
      (url) => (url.host === 'api.example.io' ? new Response('ok') : undefined),
    ]);
    const adapter = new AzureAdapter({ resolveSecret: async () => SECRET, fetch });
    const health = await adapter.checkHealth(ctx, ident);
    expect(health.state).toBe('HEALTHY');
    expect(health.message).toContain('Running');
  });

  it('reports a stopped app as unhealthy and a missing one as gone', async () => {
    const stopped = new AzureAdapter({ resolveSecret: async () => SECRET, fetch: fakeFetch([armApp({ properties: { provisioningState: 'Succeeded', runningStatus: 'Stopped' } })]).fetch });
    expect((await stopped.checkHealth(ctx, ident)).state).toBe('UNHEALTHY');

    const state = JSON.stringify({ resources: [{ mode: 'managed' }], outputs: { all: { value: appOutputs } } });
    const objects = new Map([['orkstage/ork-acme-prod-api.tfstate', state]]);
    const gone = new AzureAdapter({ resolveSecret: async () => SECRET, fetch: fakeFetch([blobStore(objects)]).fetch });
    expect(await gone.probeExists(ctx, ident)).toBe(false);
    const there = new AzureAdapter({ resolveSecret: async () => SECRET, fetch: fakeFetch([blobStore(objects), armApp({ properties: {} })]).fetch });
    expect(await there.probeExists(ctx, ident)).toBe(true);
  });

  it('restarts the active revision', async () => {
    const { fetch, calls } = fakeFetch([
      armApp({ properties: { latestReadyRevisionName: 'ork-acme-prod-api--r7' } }),
      (url, init) => (init.method === 'POST' && url.pathname.endsWith('/restart') ? new Response(null, { status: 200 }) : undefined),
    ]);
    const adapter = new AzureAdapter({ resolveSecret: async () => SECRET, fetch });
    expect(adapter.actions('container-apps').map((a) => a.name)).toEqual(['restart']);
    expect(adapter.actions('flexible-server')).toEqual([]);
    const result = await adapter.runAction(ctx, ident, { action: 'restart', params: {} });
    expect(result).toMatchObject({ status: 'started', reference: 'ork-acme-prod-api--r7' });
    const post = calls.find((c) => c.method === 'POST' && c.url.includes('/restart'))!;
    expect(post.url).toBe(`https://management.azure.com${APP_ID}/revisions/ork-acme-prod-api--r7/restart?api-version=2025-07-01`);
    await expect(adapter.runAction(ctx, ident, { action: 'redeploy', params: {} })).rejects.toMatchObject({ code: 'AZURE_ACTION_UNSUPPORTED' });
  });

  it('reads Key Vault secrets as fields and refuses other hosts', async () => {
    const { fetch, calls } = fakeFetch([
      (url) => (url.host === 'ork-db-abc123.vault.azure.net' ? Response.json({ value: JSON.stringify({ username: 'orkadmin', password: 'p', host: 'h', port: '5432', database: 'app' }) }) : undefined),
    ]);
    const adapter = new AzureAdapter({ resolveSecret: async () => SECRET, fetch });
    const ref = 'https://ork-db-abc123.vault.azure.net/secrets/credentials';
    expect(isKeyVaultSecretId(ref)).toBe(true);
    expect(await adapter.readSecret(ctx, ref)).toEqual({ username: 'orkadmin', password: 'p', host: 'h', port: '5432', database: 'app' });
    expect(calls.find((c) => c.url.includes('vault.azure.net'))?.headers.authorization).toBe('Bearer tok:https://vault.azure.net/.default');
    await expect(adapter.readSecret(ctx, 'https://evil.example.com/secrets/credentials')).rejects.toMatchObject({ code: 'AZURE_SECRET_REF_INVALID' });
  });

  it('reads container app logs from Log Analytics', async () => {
    const { fetch, calls } = fakeFetch([
      (url) => (url.host === 'api.loganalytics.io'
        ? Response.json({ tables: [{ columns: [{ name: 'TimeGenerated' }, { name: 'Log_s' }, { name: 'Stream_s' }], rows: [['2026-10-09T10:00:00Z', 'boom', 'stderr'], ['2026-10-09T09:59:00Z', 'listening', 'stdout']] }] })
        : undefined),
    ]);
    const adapter = new AzureAdapter({ resolveSecret: async () => SECRET, fetch });
    const lines = await adapter.getLogs(ctx, ident, 50);
    expect(lines).toEqual([
      { timestamp: '2026-10-09T10:00:00Z', level: 'warn', message: 'boom' },
      { timestamp: '2026-10-09T09:59:00Z', level: 'info', message: 'listening' },
    ]);
    expect(calls.find((c) => c.url.includes('loganalytics'))?.body).toContain("ContainerAppName_s == 'ork-acme-prod-api'");
  });
});
