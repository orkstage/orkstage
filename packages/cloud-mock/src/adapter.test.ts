// SPDX-License-Identifier: AGPL-3.0-only
import type { CloudTarget, ProviderContext, ResourceRequest } from '@orkstage/cloud-core';
import { runAdapterContract } from '@orkstage/cloud-core/testing';
import { describe, expect, it } from 'vitest';
import { InMemoryMockStateStore, MockAdapter, type MockTargetConfig } from './index.js';

const noSleep = async () => {};

function fixture(cfg: MockTargetConfig = {}) {
  const target: CloudTarget = {
    id: 'mock-1',
    provider: 'mock',
    name: 'Simulated AWS',
    config: { simulate: 'aws', seed: 'test', ...cfg },
    allowedRegions: ['us-east-1'],
    defaultRegion: 'us-east-1',
  };
  const context: ProviderContext = { target, region: 'us-east-1', correlationId: 'c1' };
  const sampleRequest: ResourceRequest = {
    resourceId: 'database',
    serviceKind: 'database.postgresql',
    capability: 'rds-postgres',
    name: 'ork-acme-prod-database',
    tags: { 'platform:managed': 'true' },
    spec: { size: 'small' },
    dependencyOutputs: {},
    idempotencyKey: 'key-1',
  };
  return {
    adapter: new MockAdapter(new InMemoryMockStateStore(), { sleep: noSleep }),
    context,
    sampleRequest,
    // A new desired state for a resource listed in destructivePlans is planned as a replacement.
    replacingRequest: { ...sampleRequest, idempotencyKey: 'key-2' },
  };
}

runAdapterContract('MockAdapter', () => fixture({ destructivePlans: ['database'] }));

describe('MockAdapter simulation', () => {
  it('is deterministic for the same target and resource', async () => {
    const a = fixture();
    const b = fixture();
    const ra = await a.adapter.ensureResource(a.context, a.sampleRequest);
    const rb = await b.adapter.ensureResource(b.context, b.sampleRequest);
    expect(ra.providerResourceId).toBe(rb.providerResourceId);
    expect(ra.outputs).toEqual(rb.outputs);
  });

  it('converges in place when the desired state changes', async () => {
    const { adapter, context, sampleRequest } = fixture();
    const first = await adapter.ensureResource(context, sampleRequest);
    const second = await adapter.ensureResource(context, { ...sampleRequest, idempotencyKey: 'key-2' });
    expect(second.unchanged).toBe(false);
    expect(second.providerResourceId).toBe(first.providerResourceId);
  });

  it('simulates trigger actions on existing resources', async () => {
    const { adapter, context, sampleRequest } = fixture();
    const id = { resourceId: sampleRequest.resourceId, serviceKind: sampleRequest.serviceKind, capability: sampleRequest.capability, name: sampleRequest.name };
    expect(adapter.actions().map((a) => a.name)).toEqual(['redeploy', 'restart', 'backup']);
    await expect(adapter.runAction(context, id, { action: 'restart', params: {} })).rejects.toMatchObject({ code: 'SIM_NOT_FOUND' });
    await adapter.ensureResource(context, sampleRequest);
    const run = await adapter.runAction(context, id, { action: 'redeploy', params: { ref: 'main' } });
    expect(run).toMatchObject({ status: 'started', message: expect.stringContaining('ref=main') });
  });

  it('injects failures a limited number of times', async () => {
    const { adapter, context, sampleRequest } = fixture({
      failures: { database: { failureClass: 'PROVIDER_RATE_LIMIT', times: 1 } },
    });
    await expect(adapter.ensureResource(context, sampleRequest)).rejects.toMatchObject({ failureClass: 'PROVIDER_RATE_LIMIT' });
    await expect(adapter.ensureResource(context, sampleRequest)).resolves.toMatchObject({ unchanged: false });
  });

  it('simulates health outages and drift', async () => {
    const { adapter, context, sampleRequest } = fixture();
    await adapter.ensureResource(context, sampleRequest);
    expect((await adapter.checkHealth(context, sampleRequest)).state).toBe('HEALTHY');
    await adapter.setHealthOverride(context, sampleRequest.name, 'UNHEALTHY');
    expect((await adapter.checkHealth(context, sampleRequest)).state).toBe('UNHEALTHY');

    expect((await adapter.getResource(context, sampleRequest)).observedSpecHash).toBe('key-1');
    await adapter.simulateDrift(context, sampleRequest.name, true);
    expect((await adapter.getResource(context, sampleRequest)).observedSpecHash).not.toBe('key-1');
  });

  it('keeps resources of different instances on the same target apart', async () => {
    const { adapter, context, sampleRequest } = fixture();
    const other = { ...sampleRequest, name: 'ork-globex-staging-database', idempotencyKey: 'other' };
    await adapter.ensureResource(context, sampleRequest);
    await adapter.ensureResource(context, other);
    await adapter.deleteResource(context, other);
    expect((await adapter.getResource(context, sampleRequest)).exists).toBe(true);
    expect((await adapter.getResource(context, other)).exists).toBe(false);
  });

  it('serves the catalog of the simulated provider', () => {
    const { adapter, context } = fixture({ simulate: 'azure' });
    const pg = adapter.capabilities(context.target).find((c) => c.serviceKind === 'database.postgresql');
    expect(pg?.capability).toBe('flexible-server');
  });

  it('fails validation when credentials are marked invalid', async () => {
    const { adapter, context } = fixture({ invalidCredentials: true });
    expect((await adapter.validateTarget(context)).ok).toBe(false);
  });
});
