import { AwsAdapter } from '@co/cloud-aws';
import { AdapterRegistry, type CloudTarget } from '@co/cloud-core';
import { MockAdapter, type MockStateStore } from '@co/cloud-mock';
import type { CloudProvider } from '@co/domain';
import { TofuRunner } from '@co/iac';
import type { Redis } from 'ioredis';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { PlatformConfig } from './config.js';
import type { SecretResolver } from './secrets.js';

/** Mock provider state kept in Redis so it survives restarts and is shared by API and worker. */
export class RedisMockStateStore implements MockStateStore {
  constructor(private readonly redis: Redis) {}
  get(key: string) {
    return this.redis.get(key);
  }
  async set(key: string, value: string) {
    await this.redis.set(key, value);
  }
  async delete(key: string) {
    await this.redis.del(key);
  }
}

export function createAdapterRegistry(deps: { redis: Redis; secrets: SecretResolver; runner?: TofuRunner; awsEmulatorEndpoint?: string }): {
  registry: AdapterRegistry;
  mock: MockAdapter;
} {
  const mock = new MockAdapter(new RedisMockStateStore(deps.redis));
  const registry = new AdapterRegistry()
    .register(mock)
    .register(
      new AwsAdapter({
        resolveExternalId: (ref) => deps.secrets.resolve(ref),
        runner: deps.runner,
        emulatorEndpoint: deps.awsEmulatorEndpoint,
      }),
    );
  return { registry, mock };
}

/** OpenTofu runner for the worker. Module library defaults to the repo's infra/tofu/modules. */
export function createTofuRunner(config: PlatformConfig): TofuRunner {
  return new TofuRunner({
    image: config.TOFU_IMAGE,
    modulesDir: config.TOFU_MODULES_IN_IMAGE ? undefined : (config.TOFU_MODULES_DIR ?? resolve(process.cwd(), '../../infra/tofu/modules')),
    workRoot: config.TOFU_WORK_DIR ?? join(tmpdir(), 'orkstage-tofu'),
    workVolume: config.TOFU_WORK_VOLUME,
    pluginCacheVolume: config.TOFU_PLUGIN_CACHE_VOLUME,
    network: config.TOFU_DOCKER_NETWORK,
    timeoutMs: config.TOFU_TIMEOUT_MINUTES * 60_000,
  });
}

/** Database row → adapter-facing target. */
export function toCloudTarget(row: {
  id: string;
  provider: string;
  name: string;
  config: unknown;
  credentialRef: string | null;
  allowedRegions: string[];
  defaultRegion: string;
}): CloudTarget {
  return {
    id: row.id,
    provider: row.provider as CloudProvider,
    name: row.name,
    config: (row.config ?? {}) as Record<string, unknown>,
    credentialRef: row.credentialRef ?? undefined,
    allowedRegions: row.allowedRegions,
    defaultRegion: row.defaultRegion,
  };
}
