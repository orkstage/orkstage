import { dependencyEnvironment, readCredentialFields, redact, secretEnvironment, ProviderError, type CloudCapability, type CloudTarget, type ProviderContext, type ResourceRequest } from '@orkstage/cloud-core';
import { TofuError, type TofuRunner } from '@orkstage/iac';
import { describe, expect, it, vi } from 'vitest';
import { OpenTofuAdapter, stateKeyFor, type ModuleCall, type RootParts } from './adapter.js';
import { isDestructivePlan, toProviderError } from './helpers.js';
import { s3CompatibleBackend, type StateStore } from './state.js';

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

type Creds = { token: string };

class TestAdapter extends OpenTofuAdapter<Creds> {
  readonly provider = 'digitalocean' as const;
  readonly store = new MemoryStore();
  capabilities(): CloudCapability[] {
    return [];
  }
  protected configChecks(target: CloudTarget) {
    return target.config.team ? [] : [{ name: 'Team', status: 'error' as const, message: 'team is required.' }];
  }
  protected credentials(ctx: ProviderContext) {
    return readCredentialFields<Creds>('digitalocean', ctx, this.opts.resolveSecret, { required: ['token'], singleField: 'token' });
  }
  protected async verifyIdentity() {
    return { check: { name: 'Account access', status: 'ok' as const, message: 'ok' }, identity: 'team-1' };
  }
  protected stateStore() {
    return this.store;
  }
  protected backend(_ctx: ProviderContext, key: string) {
    return s3CompatibleBackend({ endpoint: 'https://nyc3.digitaloceanspaces.com', region: 'us-east-1', bucket: 'state', key });
  }
  protected rootParts(): RootParts {
    return { requiredProviders: { digitalocean: { source: 'digitalocean/digitalocean', version: '~> 2.0' } }, providers: { digitalocean: {} } };
  }
  protected runnerEnv(_ctx: ProviderContext, creds: Creds) {
    return { DIGITALOCEAN_TOKEN: creds.token };
  }
  protected moduleCall(_ctx: ProviderContext, req: ResourceRequest): ModuleCall {
    if (req.capability === 'unknown') throw new ProviderError('X', 'nope', 'VALIDATION_ERROR', 'digitalocean');
    return { module: 'object-storage', inputs: { name: req.name } };
  }
  protected override virtualResource(_ctx: ProviderContext, req: ResourceRequest) {
    return req.capability === 'builtin' ? { kind: 'ingress', mode: 'builtin' } : undefined;
  }
  protected async health() {
    return { state: 'HEALTHY' as const, checkedAt: 'now' };
  }
}

const target: CloudTarget = { id: 't1', provider: 'digitalocean', name: 'DO', config: { team: 'acme' }, credentialRef: 'env://DO', allowedRegions: ['nyc3'], defaultRegion: 'nyc3' };
const ctx: ProviderContext = { target, region: 'nyc3', correlationId: 'c1' };
const req = (over: Partial<ResourceRequest> = {}): ResourceRequest => ({
  resourceId: 'files',
  serviceKind: 'object-storage',
  capability: 'spaces',
  name: 'ork-acme-prod-files',
  tags: {},
  spec: {},
  dependencyOutputs: {},
  idempotencyKey: 'k',
  ...over,
});

function fakeRunner(over: Partial<TofuRunner> = {}) {
  return {
    apply: vi.fn().mockResolvedValue({ outputs: { all: { kind: 'object-storage', bucket: 'b1', nested: { a: 1 } } }, changes: { add: 1, change: 0, remove: 0 } }),
    plan: vi.fn().mockResolvedValue({ changes: { add: 0, change: 0, remove: 1 }, actions: [{ address: 'module.resource.x.y', action: 'delete' }] }),
    drift: vi.fn().mockResolvedValue([]),
    destroy: vi.fn().mockResolvedValue(undefined),
    ...over,
  } as unknown as TofuRunner;
}

describe('OpenTofuAdapter', () => {
  it('builds a root config with the backend, provider and module path', () => {
    const a = new TestAdapter({ resolveSecret: async () => 't' });
    const config = a.rootConfig(ctx, req()) as { terraform: { backend: { s3: { key: string } } }; module: { resource: { source: string } } };
    expect(config.terraform.backend.s3.key).toBe(stateKeyFor('ork-acme-prod-files'));
    expect(config.module.resource.source).toBe('/modules/digitalocean/object-storage');
  });

  it('applies, stores the config beside the state, and passes credentials only as env', async () => {
    const runner = fakeRunner();
    const a = new TestAdapter({ resolveSecret: async () => 'tok', runner });
    const result = await a.ensureResource(ctx, req());
    expect(result).toEqual({ providerResourceId: 'b1', outputs: { kind: 'object-storage', bucket: 'b1' }, unchanged: false });
    const stack = vi.mocked(runner.apply).mock.calls[0]![0];
    expect(stack.env).toEqual({ DIGITALOCEAN_TOKEN: 'tok' });
    expect(JSON.stringify(stack.config)).not.toContain('tok');
    expect(stack.stateKey).toBe('t1/nyc3/orkstage/ork-acme-prod-files.tfstate');
    expect(a.store.objects.has('orkstage/ork-acme-prod-files.tfstate.config.json')).toBe(true);
  });

  it('destroys from the stored config and is idempotent', async () => {
    const runner = fakeRunner();
    const a = new TestAdapter({ resolveSecret: async () => 'tok', runner });
    await a.deleteResource(ctx, { resourceId: 'files', serviceKind: 'object-storage', capability: 'spaces', name: 'never-applied' });
    expect(runner.destroy).not.toHaveBeenCalled();
    await a.ensureResource(ctx, req());
    await a.deleteResource(ctx, { resourceId: 'files', serviceKind: 'object-storage', capability: 'spaces', name: 'ork-acme-prod-files' });
    expect(runner.destroy).toHaveBeenCalledOnce();
    expect(a.store.objects.size).toBe(0);
  });

  it('answers virtual capabilities without a runner', async () => {
    const a = new TestAdapter({ resolveSecret: async () => 'tok' });
    const first = await a.ensureResource(ctx, req({ capability: 'builtin', serviceKind: 'ingress' }));
    const again = await a.ensureResource(ctx, req({ capability: 'builtin', serviceKind: 'ingress' }));
    expect(first.unchanged).toBe(false);
    expect(again.unchanged).toBe(true);
    expect((await a.getResource(ctx, { resourceId: 'files', serviceKind: 'ingress', capability: 'builtin', name: 'ork-acme-prod-files' })).exists).toBe(true);
  });

  it('reads existence and outputs from state', async () => {
    const a = new TestAdapter({ resolveSecret: async () => 'tok' });
    const id = { resourceId: 'files', serviceKind: 'object-storage', capability: 'spaces', name: 'n1' };
    expect(await a.getResource(ctx, id)).toEqual({ exists: false, outputs: {} });
    expect((await a.checkHealth(ctx, id)).state).toBe('UNHEALTHY');
    a.store.objects.set(stateKeyFor('n1'), JSON.stringify({ resources: [{ mode: 'managed' }], outputs: { all: { value: { bucket: 'b' } } } }));
    expect(await a.getResource(ctx, id)).toEqual({ exists: true, outputs: { bucket: 'b' } });
    expect((await a.checkHealth(ctx, id)).state).toBe('HEALTHY');
  });

  it('flags destructive plans', async () => {
    const a = new TestAdapter({ resolveSecret: async () => 'tok', runner: fakeRunner() });
    expect((await a.planResource(ctx, req())).destructive).toBe(true);
  });

  it('validates config, region and credentials', async () => {
    const a = new TestAdapter({ resolveSecret: async () => 'tok' });
    const bad = await a.validateTarget({ ...ctx, region: 'ams3', target: { ...target, config: {} } });
    expect(bad.checks.map((c) => c.name)).toEqual(['Team', 'Region']);
    const good = await a.validateTarget(ctx);
    expect(good.checks.map((c) => [c.name, c.status])).toEqual([
      ['Account access', 'ok'],
      ['State storage', 'ok'],
      ['Provisioning runner', 'skipped'],
    ]);
    expect(good).toMatchObject({ ok: true, identity: 'team-1' });
    const noRef = await a.validateTarget({ ...ctx, target: { ...target, credentialRef: undefined } });
    expect(noRef.checks[0]).toMatchObject({ name: 'Credentials', status: 'error' });
  });
});

describe('helpers', () => {
  it('reads JSON or single value credentials and reports missing fields', async () => {
    const json = await readCredentialFields<{ a: string; b: string }>('vultr', ctx, async () => '{"a":"1","b":"2"}', { required: ['a', 'b'] });
    expect(json).toEqual({ a: '1', b: '2' });
    await expect(readCredentialFields('vultr', ctx, async () => '{"a":"1"}', { required: ['a', 'b'] })).rejects.toThrow('missing: b');
    expect(await readCredentialFields('vultr', ctx, async () => 'tok', { required: ['apiKey'], singleField: 'apiKey' })).toEqual({ apiKey: 'tok' });
  });

  it('builds dependency environment with secret references, never values', () => {
    const out = dependencyEnvironment({
      network: { kind: 'network', id: 'n' },
      'orders-db': { kind: 'database.postgresql', host: 'db.local', port: 5432, secret_ref: 'kv://x' },
    });
    expect(out).toEqual({ environment: { ORDERS_DB_HOST: 'db.local', ORDERS_DB_PORT: '5432' }, secretRefs: { ORDERS_DB: 'kv://x' } });
  });

  it('names secret fields as environment variables', () => {
    expect(secretEnvironment('orders-db', { url: 'postgres://x', accessKeyId: 'AK', empty: '' })).toEqual({ ORDERS_DB_URL: 'postgres://x', ORDERS_DB_ACCESS_KEY_ID: 'AK' });
  });

  it('redacts identifiers from provider messages', () => {
    const text = redact('denied for ocid1.user.oc1..aaaa in /subscriptions/0b1f6471-1bf0-4dda-aec3-111111111111 by a@b.com');
    expect(text).toBe('denied for <ocid> in /subscriptions/<id> by <email>');
  });

  it('classifies runner failures', () => {
    expect(toProviderError('gcp', new TofuError('x', ['Error 403: PERMISSION_DENIED'], 'failed')).failureClass).toBe('AUTHORIZATION_ERROR');
    expect(toProviderError('gcp', new TofuError('x', ['Error 429: rate limit'], 'failed')).failureClass).toBe('PROVIDER_RATE_LIMIT');
    expect(isDestructivePlan([{ address: 'a.b', action: 'replace' }], /a\.b/)).toBe(false);
  });
});
