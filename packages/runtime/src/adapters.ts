// SPDX-License-Identifier: AGPL-3.0-only
import { AwsAdapter } from '@orkstage/cloud-aws';
import { AzureAdapter } from '@orkstage/cloud-azure';
import { AdapterRegistry, type CloudTarget } from '@orkstage/cloud-core';
import { CoreWeaveAdapter } from '@orkstage/cloud-coreweave';
import { DigitalOceanAdapter } from '@orkstage/cloud-digitalocean';
import { GcpAdapter } from '@orkstage/cloud-gcp';
import { MagaluAdapter } from '@orkstage/cloud-magalu';
import { MockAdapter, type MockStateStore } from '@orkstage/cloud-mock';
import { OciAdapter } from '@orkstage/cloud-oci';
import { RenderAdapter } from '@orkstage/cloud-render';
import { SupabaseAdapter } from '@orkstage/cloud-supabase';
import { VercelAdapter } from '@orkstage/cloud-vercel';
import { VultrAdapter } from '@orkstage/cloud-vultr';
import type { CloudProvider } from '@orkstage/domain';
import { ecsExecutor, IN_CLUSTER, kubeClient, kubernetesExecutor, TofuRunner } from '@orkstage/iac';
import type { Redis } from 'ioredis';
import { readFileSync } from 'node:fs';
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

export interface AdapterDeps {
  redis: Redis;
  secrets: SecretResolver;
  /** Deterministic secrets from the platform key (SecretBox.derive): generated passwords that are never stored. */
  deriveSecret: (purpose: string) => string;
  /** Only the worker has one: the API validates targets and reads state but never provisions. */
  runner?: TofuRunner;
  awsEmulatorEndpoint?: string;
  /** AWS_ROLE_SESSION_MINUTES in seconds. */
  awsSessionSeconds?: number;
}

export function createAdapterRegistry(deps: AdapterDeps): { registry: AdapterRegistry; mock: MockAdapter } {
  const resolveSecret = (ref: string) => deps.secrets.resolve(ref);
  const tofu = { resolveSecret, runner: deps.runner };
  const mock = new MockAdapter(new RedisMockStateStore(deps.redis));
  const registry = new AdapterRegistry()
    .register(mock)
    .register(new AwsAdapter({ resolveExternalId: resolveSecret, runner: deps.runner, emulatorEndpoint: deps.awsEmulatorEndpoint, sessionSeconds: deps.awsSessionSeconds }))
    .register(new AzureAdapter(tofu))
    .register(new GcpAdapter(tofu))
    .register(new OciAdapter(tofu))
    .register(new DigitalOceanAdapter(tofu))
    .register(new VultrAdapter(tofu))
    .register(new CoreWeaveAdapter(tofu))
    .register(new MagaluAdapter(tofu))
    .register(new VercelAdapter({ resolveSecret }))
    .register(new RenderAdapter({ resolveSecret }))
    .register(new SupabaseAdapter({ resolveSecret, deriveSecret: deps.deriveSecret }));
  return { registry, mock };
}

/**
 * OpenTofu runner for the worker (ADR 0016), on the executor TOFU_RUNNER names. With Docker, the
 * module library defaults to the repo's infra/tofu/modules.
 */
export function createTofuRunner(config: PlatformConfig): TofuRunner {
  const workRoot = config.TOFU_WORK_DIR ?? join(tmpdir(), 'orkstage-tofu');
  const timeoutMs = config.TOFU_TIMEOUT_MINUTES * 60_000;
  if (config.TOFU_RUNNER === 'ecs') {
    const executor = ecsExecutor({
      region: config.TOFU_ECS_REGION,
      cluster: config.TOFU_ECS_CLUSTER!,
      taskDefinition: config.TOFU_ECS_TASK_DEFINITION!,
      container: config.TOFU_ECS_CONTAINER,
      subnets: config.TOFU_ECS_SUBNETS,
      securityGroups: config.TOFU_ECS_SECURITY_GROUPS,
      assignPublicIp: config.TOFU_ECS_ASSIGN_PUBLIC_IP,
      launchType: config.TOFU_ECS_LAUNCH_TYPE,
      remoteRoot: config.TOFU_REMOTE_WORK_DIR,
    });
    return new TofuRunner({ workRoot, timeoutMs, executor });
  }
  if (config.TOFU_RUNNER === 'kubernetes') {
    const executor = kubernetesExecutor({
      request: kubeClient({ apiUrl: config.TOFU_K8S_API_URL }),
      namespace: config.TOFU_K8S_NAMESPACE ?? readFileSync(IN_CLUSTER.namespaceFile, 'utf8').trim(),
      image: config.TOFU_IMAGE,
      workClaim: config.TOFU_K8S_WORK_CLAIM!,
      remoteRoot: config.TOFU_REMOTE_WORK_DIR,
      serviceAccount: config.TOFU_K8S_SERVICE_ACCOUNT,
    });
    return new TofuRunner({ workRoot, timeoutMs, executor });
  }
  return new TofuRunner({
    image: config.TOFU_IMAGE,
    modulesDir: config.TOFU_MODULES_IN_IMAGE ? undefined : (config.TOFU_MODULES_DIR ?? resolve(process.cwd(), '../../infra/tofu/modules')),
    workRoot,
    workVolume: config.TOFU_WORK_VOLUME,
    pluginCacheVolume: config.TOFU_PLUGIN_CACHE_VOLUME,
    network: config.TOFU_DOCKER_NETWORK,
    timeoutMs,
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
  environment?: string;
}): CloudTarget {
  return {
    id: row.id,
    provider: row.provider as CloudProvider,
    name: row.name,
    config: (row.config ?? {}) as Record<string, unknown>,
    credentialRef: row.credentialRef ?? undefined,
    environment: row.environment,
    allowedRegions: row.allowedRegions,
    defaultRegion: row.defaultRegion,
  };
}
