import type { CloudTarget, ProviderContext, ResourceRequest } from '@orkstage/cloud-core';
import { runAdapterContract } from '@orkstage/cloud-core/testing';
import { TofuRunner } from '@orkstage/iac';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe } from 'vitest';
import { AwsAdapter } from './adapter.js';

/**
 * Real provisioning through OpenTofu against a local MiniStack (opt-in: MINISTACK_E2E=1, with
 * `pnpm local:aws` running). Exercises the same contract as every other adapter.
 */
const enabled = process.env.MINISTACK_E2E === '1';

const target: CloudTarget = {
  id: 'e2e-ministack',
  provider: 'aws',
  name: 'MiniStack e2e',
  config: { accountId: '000000000000', emulator: 'ministack', endpointUrl: 'http://localhost:4566', runnerEndpointUrl: 'http://ministack:4566' },
  allowedRegions: ['us-east-1'],
  defaultRegion: 'us-east-1',
};

function fixture() {
  const runner = new TofuRunner({
    image: process.env.TOFU_IMAGE ?? 'ghcr.io/opentofu/opentofu:1.12.7',
    modulesDir: resolve(__dirname, '../../../infra/tofu/modules'),
    workRoot: join(tmpdir(), 'orkstage-tofu-e2e'),
    pluginCacheVolume: 'orkstage-tofu-plugins',
    network: 'cloud-orchestrator_default',
  });
  const adapter = new AwsAdapter({ resolveExternalId: async () => '', runner });
  const context: ProviderContext = { target, region: 'us-east-1', correlationId: 'e2e' };
  const sampleRequest: ResourceRequest = {
    resourceId: 'queue',
    serviceKind: 'queue',
    capability: 'sqs',
    name: 'co-e2e-contract-queue',
    tags: { 'platform:managed': 'true', 'platform:environment': 'development' },
    spec: { fifo: false, deadLetter: true },
    dependencyOutputs: {},
    idempotencyKey: 'e2e-1',
  };
  return { adapter, context, sampleRequest };
}

if (enabled) runAdapterContract('AwsAdapter on MiniStack', fixture);
else describe.skip('AwsAdapter on MiniStack (set MINISTACK_E2E=1)', () => {});
