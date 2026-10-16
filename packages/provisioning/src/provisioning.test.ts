// SPDX-License-Identifier: AGPL-3.0-only
import { AdapterRegistry, type CloudTarget } from '@orkstage/cloud-core';
import { InMemoryMockStateStore, MockAdapter, type MockTargetConfig } from '@orkstage/cloud-mock';
import { ALL_FEATURES, type TenantFeatures } from '@orkstage/domain';
import { loadBuiltinTemplates, loadMarketplaceTemplates } from '@orkstage/templates/builtin';
import type { EnvironmentTemplate } from '@orkstage/templates';
import { describe, expect, it } from 'vitest';
import {
  compileInfrastructure,
  diffPlan,
  executeApply,
  executeDestroy,
  idempotencyKeyFor,
  previewProviderPlans,
  previewTemplate,
  readDependencySecret,
  renderPlan,
  resolveTriggerParams,
  triggerAllows,
  type CompileInput,
  type ExecutionHooks,
} from './index.js';

const templates = Object.fromEntries(loadBuiltinTemplates().map((b) => [b.template.metadata.name, b.template]));

function mockTarget(id: string, simulate: NonNullable<MockTargetConfig['simulate']>, region: string, extra: MockTargetConfig = {}): CloudTarget {
  return {
    id,
    provider: 'mock',
    name: `Simulated ${simulate} (${id})`,
    config: { simulate, seed: id, latencyMs: { min: 0, max: 0 }, ...extra },
    allowedRegions: [region],
    defaultRegion: region,
  };
}

const aws = mockTarget('aws-a', 'aws', 'us-east-1');
const azure = mockTarget('azure-b', 'azure', 'eastus');
const oci = mockTarget('oci-c', 'oci', 'us-ashburn-1');

function input(template: EnvironmentTemplate, bindings: CompileInput['bindings'], features: TenantFeatures = ALL_FEATURES): CompileInput {
  return {
    template,
    limits: {},
    features,
    organizationId: 'org-1',
    tenant: { id: 'tenant-1', slug: 'acme' },
    instance: { id: 'inst-1', slug: 'prod', environment: 'production' },
    bindings,
  };
}

function registry() {
  return new AdapterRegistry().register(new MockAdapter(new InMemoryMockStateStore(), { sleep: async () => {} }));
}

function recordingHooks() {
  const events: string[] = [];
  const hooks: ExecutionHooks = {
    onStart: async (id, attempt) => void events.push(`start:${id}:${attempt}`),
    onSuccess: async (id) => void events.push(`ok:${id}`),
    onFailure: async (id, f) => void events.push(`fail:${id}:${f.failureClass}`),
    onSkipped: async (id) => void events.push(`skip:${id}`),
    onRetry: async (id, attempt) => void events.push(`retry:${id}:${attempt}`),
  };
  return { events, hooks };
}

const multiCloudBindings = {
  primary: { target: aws, region: 'us-east-1' },
  data: { target: azure, region: 'eastus' },
  storage: { target: oci, region: 'us-ashburn-1' },
};

describe('compiler: web app on managed platforms', () => {
  const bindings = {
    web: { target: mockTarget('vercel-v', 'vercel', 'gru1'), region: 'gru1' },
    data: { target: mockTarget('supabase-s', 'supabase', 'sa-east-1'), region: 'sa-east-1' },
    files: { target: mockTarget('aws-f', 'aws', 'sa-east-1'), region: 'sa-east-1' },
  };
  const resolved = compileInfrastructure(input(templates['web-platforms']!, bindings), registry());

  it('places the frontend, database and bucket on three providers', () => {
    expect(resolved.issues.filter((i) => i.severity === 'error')).toEqual([]);
    const placement = Object.fromEntries(resolved.resources.map((r) => [r.id, `${r.simulatedProvider}:${r.capability}`]));
    expect(placement).toEqual({ database: 'supabase:supabase-postgres', files: 'aws:s3', web: 'vercel:vercel-project' });
  });

  it('warns, instead of failing, about a database reached over TLS from another provider', () => {
    expect(resolved.policyResults.find((p) => p.policy === 'no-public-database')).toMatchObject({ status: 'warn', resourceId: 'database' });
  });

  it('still fails a public database nobody declared a cross provider link to', () => {
    const template = structuredClone(templates['web-platforms']!);
    template.spec.connectivity = [];
    const other = compileInfrastructure(input(template, bindings), registry());
    expect(other.policyResults.find((p) => p.policy === 'no-public-database')).toMatchObject({ status: 'fail' });
  });
});

describe('policy: target environment', () => {
  const template = (): EnvironmentTemplate => {
    const t = structuredClone(templates['web-platforms']!);
    return t;
  };
  const bindingsFor = (environment?: string) => ({
    web: { target: { ...mockTarget('vercel-v', 'vercel', 'gru1'), environment }, region: 'gru1' },
    data: { target: { ...mockTarget('supa-s', 'supabase', 'sa-east-1'), environment }, region: 'sa-east-1' },
    files: { target: { ...mockTarget('aws-f', 'aws', 'us-east-1'), environment }, region: 'us-east-1' },
  });
  const result = (environment?: string) =>
    compileInfrastructure(input(template(), bindingsFor(environment)), registry()).policyResults.filter((p) => p.policy === 'target-environment');

  it('passes for targets of the same environment, or marked any, or without an environment', () => {
    for (const env of ['production', 'any', undefined]) expect(result(env)).toEqual([expect.objectContaining({ status: 'pass' })]);
  });

  it('fails a production instance on a development target, naming the target', () => {
    const fails = result('development');
    expect(fails.length).toBe(3);
    expect(fails[0]).toMatchObject({ status: 'fail', message: expect.stringContaining('is for development, but this instance is production') });
  });
});

describe('compiler — spec §42.17 multi-cloud reference', () => {
  const resolved = compileInfrastructure(input(templates['multicloud-reference']!, multiCloudBindings), registry());

  it('is valid and places each resource on its own provider', () => {
    expect(resolved.issues).toEqual([]);
    const placement = Object.fromEntries(resolved.resources.map((r) => [r.id, `${r.simulatedProvider}:${r.capability}`]));
    expect(placement).toMatchObject({
      api: 'aws:ecs-fargate',
      worker: 'aws:ecs-ec2',
      registry: 'aws:ecr',
      ingress: 'aws:alb',
      dns: 'aws:route53',
      database: 'azure:flexible-server',
      storage: 'oci:object-storage',
    });
  });

  it('chooses secure public endpoints for cross-cloud links and warns about it', () => {
    const apiDb = resolved.connectivity.find((c) => c.from === 'api' && c.to === 'database')!;
    expect(apiDb).toMatchObject({ crossCloud: true, strategy: 'public-tls-allowlist' });
    expect(resolved.policyResults.some((p) => p.policy === 'cross-cloud-connectivity' && p.status === 'warn')).toBe(true);
  });

  it('tags every resource for correlation and cleanup', () => {
    for (const r of resolved.resources) {
      expect(r.tags).toMatchObject({ 'platform:managed': 'true', 'platform:tenant-id': 'tenant-1', 'platform:instance-id': 'inst-1' });
    }
  });

  it('produces an approximate cost estimate and a grouped plan', () => {
    expect(resolved.cost.confidence).toBe('approximate');
    expect(resolved.cost.total).toBeGreaterThan(0);
    const plan = diffPlan(resolved, []);
    expect(plan.counts.CREATE).toBe(resolved.resources.length);
    expect(plan.groups.map((g) => g.provider).sort()).toEqual(['aws', 'azure', 'oci']);
    expect(renderPlan('acme-prod', plan)).toContain('AZURE / Simulated azure (azure-b) / eastus');
  });

  it('applies drifted resources again, even when their spec is unchanged', () => {
    const known = resolved.resources.map((r) => ({
      resourceId: r.id, type: r.type, specHash: r.specHash, targetId: r.targetId, region: r.region,
      provider: r.provider, capabilityName: r.capabilityName, name: r.name, drifted: r.id === 'database',
    }));
    const plan = diffPlan(resolved, known);
    expect(plan.counts).toMatchObject({ UPDATE: 1, NOOP: resolved.resources.length - 1 });
    expect(renderPlan('acme-prod', plan)).toMatch(/UPDATE .* database \(restore drift\)/);
  });
});

describe('compiler — same template, AWS-only variant', () => {
  it('resolves without changing the template', () => {
    const awsOnly = { primary: multiCloudBindings.primary, data: multiCloudBindings.primary, storage: multiCloudBindings.primary };
    const resolved = compileInfrastructure(input(templates['multicloud-reference']!, awsOnly), registry());
    expect(resolved.issues).toEqual([]);
    expect(new Set(resolved.resources.map((r) => r.simulatedProvider))).toEqual(new Set(['aws']));
    expect(resolved.resources.find((r) => r.id === 'database')!.capability).toBe('rds-postgres');
    expect(resolved.connectivity.every((c) => c.strategy === 'private-network')).toBe(true);
  });
});

describe('compiler — failing before cloud mutation', () => {
  it('rejects unbound placement slots', () => {
    const resolved = compileInfrastructure(input(templates['multicloud-reference']!, { primary: multiCloudBindings.primary }), registry());
    expect(resolved.valid).toBe(false);
    expect(resolved.issues.some((i) => i.message.includes('"data" is not bound'))).toBe(true);
  });

  it('rejects private-required links across clouds', () => {
    const t = structuredClone(templates['multicloud-reference']!);
    t.spec.connectivity[0]!.mode = 'private-required';
    const resolved = compileInfrastructure(input(t, multiCloudBindings), registry());
    expect(resolved.issues.map((i) => i.code)).toContain('POLICY_CROSS_CLOUD_CONNECTIVITY');
  });

  it('rejects multi-cloud placement when MULTI_CLOUD is off for the tenant', () => {
    const t = structuredClone(templates['multicloud-reference']!);
    const db = t.spec.resources.find((r) => r.id === 'database')!;
    if (db.type === 'database.postgresql') db.highAvailability = 'none';
    const resolved = compileInfrastructure(input(t, multiCloudBindings, { ...ALL_FEATURES, multiCloud: false }), registry());
    expect(resolved.issues.map((i) => i.code)).toContain('POLICY_MULTI_CLOUD_ALLOWED');
  });

  it('rejects public databases and non-production templates in production', () => {
    const t = structuredClone(templates['free-validation']!);
    const db = t.spec.resources.find((r) => r.id === 'database')!;
    if (db.type === 'database.postgresql') db.publicAccess = true;
    const resolved = compileInfrastructure(input(t, { primary: multiCloudBindings.primary }), registry());
    const codes = resolved.issues.map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(['POLICY_NO_PUBLIC_DATABASE', 'POLICY_NON_PRODUCTION_TEMPLATE']));
  });

  it('rejects slots bound to a disallowed provider', () => {
    const real: CloudTarget = { ...aws, id: 'real', provider: 'azure' };
    const resolved = compileInfrastructure(input(templates['multicloud-reference']!, { ...multiCloudBindings, primary: { target: real, region: 'us-east-1' } }), registry());
    expect(resolved.issues.some((i) => i.message.includes('allows aws, mock'))).toBe(true);
  });
});

describe('executor', () => {
  const ids = { tenantId: 'tenant-1', instanceId: 'inst-1', correlationId: 'c1' };

  it('provisions the full DAG in dependency order', async () => {
    const reg = registry();
    const resolved = compileInfrastructure(input(templates['multicloud-reference']!, multiCloudBindings), reg);
    const { events, hooks } = recordingHooks();
    const outcome = await executeApply({ resolved, registry: reg, hooks, ...ids });
    expect(Object.values(outcome).every((s) => s === 'SUCCEEDED')).toBe(true);
    const order = events.filter((e) => e.startsWith('ok:')).map((e) => e.slice(3));
    expect(order.indexOf('database')).toBeLessThan(order.indexOf('api'));
    expect(order.indexOf('ingress')).toBeLessThan(order.indexOf('dns'));
  });

  it('isolates failures: OCI storage failing skips only its dependents (spec §42.12)', async () => {
    const reg = registry();
    const failingOci = mockTarget('oci-c', 'oci', 'us-ashburn-1', { failures: { storage: { failureClass: 'QUOTA_EXCEEDED' } } });
    const resolved = compileInfrastructure(input(templates['multicloud-reference']!, { ...multiCloudBindings, storage: { target: failingOci, region: 'us-ashburn-1' } }), reg);
    const { hooks } = recordingHooks();
    const outcome = await executeApply({ resolved, registry: reg, hooks, ...ids });
    expect(outcome).toMatchObject({ storage: 'FAILED', api: 'SKIPPED', ingress: 'SUCCEEDED', dns: 'SUCCEEDED', database: 'SUCCEEDED', worker: 'SUCCEEDED', network: 'SUCCEEDED' });
  });

  it('retries transient failures with backoff', async () => {
    const reg = registry();
    const flaky = mockTarget('azure-b', 'azure', 'eastus', { failures: { database: { failureClass: 'PROVIDER_RATE_LIMIT', times: 2 } } });
    const resolved = compileInfrastructure(input(templates['multicloud-reference']!, { ...multiCloudBindings, data: { target: flaky, region: 'eastus' } }), reg);
    const { events, hooks } = recordingHooks();
    const delays: number[] = [];
    const outcome = await executeApply({ resolved, registry: reg, hooks, ...ids, sleep: async (ms) => void delays.push(ms) });
    expect(outcome.database).toBe('SUCCEEDED');
    expect(events).toEqual(expect.arrayContaining(['retry:database:1', 'retry:database:2', 'start:database:3']));
    expect(delays).toEqual([2000, 4000]);
  });

  it('does not retry non-transient failures', async () => {
    const reg = registry();
    const broken = mockTarget('azure-b', 'azure', 'eastus', { failures: { database: { failureClass: 'POLICY_VIOLATION' } } });
    const resolved = compileInfrastructure(input(templates['multicloud-reference']!, { ...multiCloudBindings, data: { target: broken, region: 'eastus' } }), reg);
    const { events, hooks } = recordingHooks();
    await executeApply({ resolved, registry: reg, hooks, ...ids });
    expect(events.filter((e) => e.startsWith('start:database'))).toHaveLength(1);
  });

  it('resumes without redoing converged resources', async () => {
    const reg = registry();
    const resolved = compileInfrastructure(input(templates['multicloud-reference']!, multiCloudBindings), reg);
    const first = recordingHooks();
    const completed: Record<string, { idempotencyKey: string; outputs: Record<string, string>; providerResourceId: string }> = {};
    await executeApply({
      resolved,
      registry: reg,
      ...ids,
      hooks: { ...first.hooks, onSuccess: async (id, r) => void (completed[id] = { idempotencyKey: '', outputs: r.outputs as Record<string, string>, providerResourceId: r.providerResourceId }) },
    });
    // Real keys would come from persisted steps; recompute them as the worker does.
    const { idempotencyKeyFor } = await import('./executor.js');
    for (const r of resolved.resources) completed[r.id]!.idempotencyKey = idempotencyKeyFor(ids.tenantId, ids.instanceId, r);

    const second = recordingHooks();
    await executeApply({ resolved, registry: reg, hooks: second.hooks, completed, ...ids });
    expect(second.events).toEqual([]);

    // Someone deletes the storage bucket outside OrkStage: it is re-created, not assumed to exist.
    const storage = resolved.resources.find((r) => r.id === 'storage')!;
    await reg.get('mock').deleteResource({ target: resolved.targets[storage.targetId]!, region: storage.region, correlationId: 'x' }, { resourceId: storage.id, serviceKind: storage.type, capability: storage.capability, name: storage.name });
    const third = recordingHooks();
    await executeApply({ resolved, registry: reg, hooks: third.hooks, completed, ...ids });
    expect(third.events).toEqual(['start:storage:1', 'ok:storage']);
  });

  it('destroys dependents before dependencies', async () => {
    const reg = registry();
    const resolved = compileInfrastructure(input(templates['multicloud-reference']!, multiCloudBindings), reg);
    await executeApply({ resolved, registry: reg, hooks: recordingHooks().hooks, ...ids });
    const { events, hooks } = recordingHooks();
    const outcome = await executeDestroy({ resolved, registry: reg, hooks: { ...hooks, onSuccess: async (id) => void events.push(`ok:${id}`) }, correlationId: 'c2', providerIds: {} });
    expect(Object.values(outcome).every((s) => s === 'SUCCEEDED')).toBe(true);
    const order = events.filter((e) => e.startsWith('ok:')).map((e) => e.slice(3));
    expect(order.indexOf('dns')).toBeLessThan(order.indexOf('ingress'));
    expect(order.indexOf('api')).toBeLessThan(order.indexOf('ingress'));
    expect(order.indexOf('api')).toBeLessThan(order.indexOf('database'));
    expect(order.indexOf('api')).toBeLessThan(order.indexOf('network'));
  });
});

describe('provider plans', () => {
  const ids = { tenantId: 'tenant-1', instanceId: 'inst-1', correlationId: 'c1' };

  async function applied(extra: MockTargetConfig = {}) {
    const reg = registry();
    const data = mockTarget('azure-b', 'azure', 'eastus', extra);
    const resolved = compileInfrastructure(input(templates['multicloud-reference']!, { ...multiCloudBindings, data: { target: data, region: 'eastus' } }), reg);
    const existing: Record<string, { idempotencyKey: string; outputs: Record<string, string> }> = {};
    await executeApply({
      resolved,
      registry: reg,
      ...ids,
      hooks: { ...recordingHooks().hooks, onSuccess: async (id, r) => void (existing[id] = { idempotencyKey: '', outputs: r.outputs as Record<string, string> }) },
    });
    for (const r of resolved.resources) existing[r.id]!.idempotencyKey = idempotencyKeyFor(ids.tenantId, ids.instanceId, r);
    // Change the database spec, as a new template version or variable would.
    const changed = { ...resolved, resources: resolved.resources.map((r) => (r.id === 'database' ? { ...r, spec: { ...r.spec, storageGb: 500 }, specHash: `${r.specHash}-v2` } : r)) };
    return { reg, changed, existing };
  }

  it('plans only changed existing resources, as in-place updates', async () => {
    const { reg, changed, existing } = await applied();
    const summary = await previewProviderPlans({ resolved: changed, registry: reg, ...ids, existing });
    expect(summary.entries).toEqual([{ resourceId: 'database', status: 'planned', plan: expect.objectContaining({ destructive: false, changes: { add: 0, change: 1, remove: 0 } }) }]);
    expect(summary.destructive).toBe(false);
  });

  it('flags replacements as destructive', async () => {
    const { reg, changed, existing } = await applied({ destructivePlans: ['database'] });
    const summary = await previewProviderPlans({ resolved: changed, registry: reg, ...ids, existing });
    expect(summary.destructive).toBe(true);
    expect(summary.entries[0]).toMatchObject({ resourceId: 'database', status: 'planned', plan: { actions: [{ action: 'replace' }] } });
  });

  it('skips resources whose dependencies do not exist yet', async () => {
    const { reg, changed, existing } = await applied();
    const api = changed.resources.find((r) => r.id === 'api')!;
    expect(api.dependsOn.length).toBeGreaterThan(0);
    const withApi = { ...changed, resources: changed.resources.map((r) => (r.id === 'api' ? { ...r, specHash: `${r.specHash}-v2` } : r)) };
    delete existing[api.dependsOn[0]!];
    const summary = await previewProviderPlans({ resolved: withApi, registry: reg, ...ids, existing });
    expect(summary.entries.find((e) => e.resourceId === 'api')).toMatchObject({ status: 'skipped' });
  });
});

describe('readDependencySecret', () => {
  const target = (id: string, provider: 'vercel' | 'supabase'): CloudTarget => ({ id, provider, name: id, config: {}, allowedRegions: ['r'], defaultRegion: 'r' });
  const res = (id: string, provider: 'vercel' | 'supabase', dependsOn: string[] = []) => ({
    id, type: 't', slot: 's', provider, targetId: `${provider}-t`, targetName: 'n', region: 'r', capability: 'c', capabilityName: 'c', name: id, tags: {}, spec: {}, dependsOn, critical: true, specHash: 'h',
  });
  const db = res('db', 'supabase');
  const web = res('web', 'vercel', ['db']);
  const resolved = { resources: [db, web], targets: { 'supabase-t': target('supabase-t', 'supabase'), 'vercel-t': target('vercel-t', 'vercel') } } as unknown as Parameters<typeof readDependencySecret>[1];
  const owner = (readSecret?: (ctx: unknown, ref: string) => Promise<Record<string, string>>) =>
    new AdapterRegistry().register({ provider: 'supabase', simulated: false, readSecret } as never).register({ provider: 'vercel', simulated: false } as never);

  it('asks the owning adapter, with the owner target', async () => {
    const seen: unknown[] = [];
    const registry = owner(async (ctx, ref) => (seen.push([(ctx as { target: CloudTarget }).target.id, ref]), { password: 'p' }));
    expect(await readDependencySecret(registry, resolved, web, 'db', { secret_ref: 'supabase://x/database' }, 'c')).toEqual({ password: 'p' });
    expect(seen).toEqual([['supabase-t', 'supabase://x/database']]);
  });

  it('refuses undeclared dependencies, missing refs and owners that cannot share', async () => {
    await expect(readDependencySecret(owner(async () => ({})), resolved, db, 'web', { secret_ref: 'x' }, 'c')).rejects.toThrow('dependsOn');
    await expect(readDependencySecret(owner(async () => ({})), resolved, web, 'db', {}, 'c')).rejects.toThrow('does not publish');
    await expect(readDependencySecret(owner(), resolved, web, 'db', { secret_ref: 'x' }, 'c')).rejects.toThrow('cannot hand');
  });
});

describe('triggers', () => {
  const trigger = { name: 'redeploy-site', resource: 'web', action: 'redeploy', params: { target: 'production' }, overridable: ['ref'], on: { manual: true, webhook: true } };
  const descriptor = {
    name: 'redeploy',
    description: 'Redeploy',
    params: [
      { name: 'ref', type: 'string' as const },
      { name: 'target', type: 'string' as const, required: true },
      { name: 'clearCache', type: 'boolean' as const },
    ],
  };

  it('merges defaults with overridable values and checks the action', () => {
    expect(resolveTriggerParams(trigger, { ref: 'main' }, descriptor)).toEqual({ ok: true, params: { target: 'production', ref: 'main' } });
  });

  it('rejects names that are not overridable, unknown params and wrong types', () => {
    const r = resolveTriggerParams({ ...trigger, params: { target: 1, extra: 'x' } as never }, { target: 'preview' }, descriptor);
    expect(r).toEqual({
      ok: false,
      errors: ['Parameter "target" cannot be set when running "redeploy-site".', 'Parameter "target" must be a string.', 'Action "redeploy" has no parameter "extra".'],
    });
  });

  it('knows which sources may start a trigger', () => {
    expect(triggerAllows(trigger, 'MANUAL')).toBe(true);
    expect(triggerAllows(trigger, 'WEBHOOK')).toBe(true);
    expect(triggerAllows(trigger, 'SCHEDULE')).toBe(false);
    expect(triggerAllows({ ...trigger, on: { manual: false, webhook: false, schedule: '0 3 * * *' } }, 'SCHEDULE')).toBe(true);
  });
});

describe('compiler: provider feature flags', () => {
  it('blocks slots bound to a disabled provider and leaves enabled ones alone', () => {
    const bindings = { primary: { target: { ...aws, provider: 'azure' as const }, region: 'us-east-1' } };
    const off = compileInfrastructure({ ...input(templates['sandbox-min-cost']!, bindings), providerEnabled: (p) => p !== 'azure' }, registry());
    expect(off.issues.some((i) => i.code === 'PROVIDER_DISABLED')).toBe(true);
    const simulated = compileInfrastructure({ ...input(templates['sandbox-min-cost']!, { primary: { target: aws, region: 'us-east-1' } }), providerEnabled: (p) => p === 'mock' }, registry());
    expect(simulated.issues.filter((i) => i.code === 'PROVIDER_DISABLED')).toEqual([]);
  });
});

describe('compiler: marketplace templates', () => {
  it.each(loadMarketplaceTemplates().map((s) => [s.slug, s.template] as const))('%s compiles in preview', (_slug, template) => {
    const preview = previewTemplate(template, registry());
    expect(preview.resolved.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(preview.cost.total).toBeGreaterThan(0);
  });

  it('previews on the first allowed provider of each slot', () => {
    const preview = previewTemplate(templates['web-platforms']!, registry());
    expect(preview.placements).toEqual({ web: 'vercel', data: 'supabase', files: 'aws' });
    expect(preview.providers).toEqual(['vercel', 'render', 'supabase', 'aws', 'gcp', 'azure', 'digitalocean']);
  });
});
