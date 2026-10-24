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

describe('MockAdapter releases (ADR 0009)', () => {
  const service = (image: string, key: string, release?: ResourceRequest['release']): ResourceRequest => ({
    resourceId: 'api',
    serviceKind: 'compute.container-service',
    capability: 'ecs-fargate',
    name: 'ork-acme-prod-api',
    tags: {},
    spec: { image, port: 8080 },
    dependencyOutputs: {},
    idempotencyKey: key,
    release,
  });

  it('offers canary and blue/green for container services only', () => {
    const { adapter } = fixture();
    expect(adapter.releaseStrategies('ecs-fargate')).toEqual(['canary', 'blueGreen']);
    expect(adapter.releaseStrategies('rds-postgres')).toEqual([]);
  });

  it('runs a canary beside the old release, promotes it, and a plain apply returns to the old one', async () => {
    const { adapter, context } = fixture();
    await adapter.ensureResource(context, service('repo/api@sha256:1', 'k1'));
    const canary = await adapter.ensureResource(context, service('repo/api@sha256:2', 'k2', { strategy: 'canary', trafficPercent: 10 }));
    expect(canary.outputs).toMatchObject({ image: 'repo/api@sha256:2', traffic_percent: 10, previous_image: 'repo/api@sha256:1', release_strategy: 'canary' });
    await adapter.promoteRelease(context, { resourceId: 'api', serviceKind: 'compute.container-service', capability: 'ecs-fargate', name: 'ork-acme-prod-api' });
    const promoted = await adapter.getResource(context, { resourceId: 'api', serviceKind: 'compute.container-service', capability: 'ecs-fargate', name: 'ork-acme-prod-api' });
    expect(promoted.outputs).toMatchObject({ image: 'repo/api@sha256:2', traffic_percent: 100 });
    expect(promoted.outputs.previous_image).toBeUndefined();
    const back = await adapter.ensureResource(context, service('repo/api@sha256:1', 'k1'));
    expect(back.outputs).toMatchObject({ image: 'repo/api@sha256:1', traffic_percent: 100 });
    expect(back.outputs.previous_image).toBeUndefined();
  });

  it('reports a configured bad image as unhealthy while it runs', async () => {
    const { adapter, context } = fixture({ unhealthyImages: ['repo/api@sha256:bad'] });
    const ref = { resourceId: 'api', serviceKind: 'compute.container-service', capability: 'ecs-fargate', name: 'ork-acme-prod-api' };
    await adapter.ensureResource(context, service('repo/api@sha256:bad', 'k1'));
    expect((await adapter.checkHealth(context, ref)).state).toBe('UNHEALTHY');
    await adapter.ensureResource(context, service('repo/api@sha256:good', 'k2'));
    expect((await adapter.checkHealth(context, ref)).state).toBe('HEALTHY');
  });
});

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
    expect(adapter.actions().map((a) => a.name)).toEqual(['redeploy', 'restart', 'service.scale', 'database.reboot', 'cdn.invalidate', 'backup', 'restore']);
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
