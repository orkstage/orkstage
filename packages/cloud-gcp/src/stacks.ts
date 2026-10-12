// SPDX-License-Identifier: AGPL-3.0-only
import {
  byKind,
  dependencyEnvironment,
  needKind,
  ProviderError,
  type ProviderContext,
  type ResourceOutputs,
  type ResourceRequest,
} from '@orkstage/cloud-core';
import type { ModuleCall, RootParts } from '@orkstage/cloud-tofu';
import { fitName, sha256 } from '@orkstage/domain';
import { gcpConfig, labelsFrom } from './config.js';

const MODULE_BY_CAPABILITY: Record<string, string> = {
  vpc: 'network',
  'cloud-run': 'container-service',
  'cloud-sql-postgres': 'postgres',
  'memorystore-redis': 'redis',
  gcs: 'object-storage',
};

/** Capabilities answered without infrastructure of their own. */
export const VIRTUAL_CAPABILITIES = new Set(['cloud-run-ingress']);

const SQL_TIER: Record<string, string> = {
  micro: 'db-f1-micro',
  small: 'db-g1-small',
  medium: 'db-custom-1-3840',
  large: 'db-custom-2-7680',
  xlarge: 'db-custom-4-15360',
};

const REDIS_GB: Record<string, number> = { micro: 1, small: 2, medium: 5, large: 13 };

/** Secret Manager secret resource names; anything else cannot be mounted by Cloud Run. */
export const SECRET_NAME = /^projects\/[^/]+\/secrets\/[^/]+$/;

/** Environment names Cloud Run sets itself and rejects in a service definition. */
const RESERVED_ENV = new Set(['PORT', 'K_SERVICE', 'K_REVISION', 'K_CONFIGURATION']);

type Spec = Record<string, unknown>;

/**
 * Cloud Run accepts 1, 2, 4, 6 or 8 vCPU (fractions need concurrency 1 and first generation
 * instances), and each CPU size has a memory range. Rounds up to the nearest valid pair.
 */
export function cloudRunResources(cpu: number, memoryMiB: number): { cpu: string; memory: string } {
  const memory = Math.min(Math.max(128, Math.round(memoryMiB)), 32768);
  const cpuForMemory = memory > 24576 ? 8 : memory > 16384 ? 6 : memory > 8192 ? 4 : memory > 4096 ? 2 : 1;
  const size = [1, 2, 4, 6, 8].find((v) => v >= Math.max(cpu, cpuForMemory)) ?? 8;
  const minMemory = size >= 6 ? 4096 : size === 4 ? 2048 : 128;
  return { cpu: String(size), memory: `${Math.max(memory, minMemory)}Mi` };
}

/** Instance bounds: the autoscaling range when set, otherwise fixed `replicas`. */
export function cloudRunScaling(spec: Spec): { min_instances: number; max_instances: number } {
  const a = spec.autoscaling as { minReplicas: number; maxReplicas: number } | undefined;
  if (a) return { min_instances: a.minReplicas, max_instances: Math.max(1, a.minReplicas, a.maxReplicas) };
  const replicas = Number(spec.replicas ?? 1);
  return { min_instances: replicas, max_instances: Math.max(1, replicas) };
}

/** Memorystore tier, replica count and memory for a logical size and replica count. */
export function redisShape(size: string, replicas: number) {
  const gb = REDIS_GB[size] ?? 1;
  if (replicas <= 0) return { tier: 'BASIC', memory_size_gb: gb, replica_count: 0, read_replicas: false };
  if (replicas === 1) return { tier: 'STANDARD_HA', memory_size_gb: gb, replica_count: 1, read_replicas: false };
  // Read replicas (more than one replica) need at least 5 GB.
  return { tier: 'STANDARD_HA', memory_size_gb: Math.max(gb, 5), replica_count: Math.min(replicas, 5), read_replicas: true };
}

const isGcpNetwork = (o: ResourceOutputs | undefined) => Boolean(o && String(o.network_id ?? '').startsWith('projects/'));

/** Module and inputs for one logical resource. */
export function moduleCall(ctx: ProviderContext, req: ResourceRequest): ModuleCall {
  const module = MODULE_BY_CAPABILITY[req.capability];
  if (!module) {
    throw new ProviderError('GCP_CAPABILITY_NOT_IMPLEMENTED', `${req.capability} is not implemented by the Google Cloud adapter. Choose another implementation.`, 'VALIDATION_ERROR', 'gcp');
  }
  const cfg = gcpConfig(ctx.target);
  const spec = req.spec as Spec;
  const deps = req.dependencyOutputs;
  const production = req.tags['platform:environment'] === 'production';
  const region = ctx.region;

  switch (module) {
    case 'network': {
      const octet = 16 + (parseInt(sha256(req.name).slice(0, 4), 16) % 200);
      return { module, inputs: { name: fitName(req.name, 55), region, subnet_cidr: `10.${octet}.0.0/20`, nat_gateway: Boolean(spec.natGateway) } };
    }
    case 'container-service': {
      const network = byKind(deps, 'network');
      const ingress = byKind(deps, 'ingress');
      const { environment: depEnv, secretRefs } = dependencyEnvironment(deps);
      const environment = Object.fromEntries(Object.entries(depEnv).filter(([k]) => !RESERVED_ENV.has(k)));
      const secrets: Record<string, string> = {};
      for (const [key, ref] of Object.entries(secretRefs)) {
        if (SECRET_NAME.test(ref)) secrets[`${key}_CREDENTIALS`] = ref;
        else ctx.log?.('warn', `${req.resourceId}: ${key} credentials live outside Google Secret Manager and are not mounted.`);
      }
      const buckets = Object.values(deps)
        .filter((o) => o.kind === 'object-storage' && String(o.endpoint ?? '').startsWith('https://storage.googleapis.com/'))
        .map((o) => String(o.bucket));
      const nat = network?.nat === true || network?.nat === 'true';
      return {
        module,
        inputs: {
          name: fitName(req.name, 49),
          region,
          service_account_id: fitName(req.name, 30),
          image: spec.image,
          ...cloudRunResources(Number(spec.cpu ?? 0.25), Number(spec.memoryMiB ?? 512)),
          port: spec.port ?? null,
          ...cloudRunScaling(spec),
          // A route through the built in ingress means the service answers on its public URL.
          public: Boolean(spec.public) || ingress?.mode === 'cloud-run',
          health_check_path: spec.healthCheckPath ?? '',
          network_id: isGcpNetwork(network) ? network!.network_id : '',
          subnet_id: isGcpNetwork(network) ? network!.subnet_id : '',
          egress: nat ? 'ALL_TRAFFIC' : 'PRIVATE_RANGES_ONLY',
          environment,
          secrets,
          buckets,
          production,
        },
      };
    }
    case 'postgres': {
      const network = byKind(deps, 'network');
      const backup = (spec.backup ?? {}) as { enabled?: boolean; retentionDays?: number };
      return {
        module,
        inputs: {
          name: fitName(req.name, 60),
          region,
          database_version: `POSTGRES_${String(spec.version ?? '17').split('.')[0]}`,
          tier: SQL_TIER[String(spec.size ?? 'small')] ?? 'db-g1-small',
          disk_gib: Math.max(10, Number(spec.storageGiB ?? 20)),
          high_availability: spec.highAvailability === 'zone-redundant',
          backup_enabled: backup.enabled ?? true,
          backup_retention_days: Math.max(1, backup.retentionDays ?? 7),
          public_access: Boolean(spec.publicAccess),
          network_id: isGcpNetwork(network) ? network!.network_id : '',
          production,
        },
      };
    }
    case 'redis': {
      const network = needKind('gcp', deps, 'network', req.resourceId);
      return {
        module,
        inputs: {
          name: fitName(req.name, 40),
          region,
          ...redisShape(String(spec.size ?? 'micro'), Number(spec.replicas ?? 0)),
          network_id: network.network_id,
          production,
        },
      };
    }
    case 'object-storage': {
      const retention = Number(spec.retentionDays ?? 0);
      return {
        module,
        inputs: {
          // Bucket names are global: a short hash of the project keeps them unique across customers.
          name: fitName(`${req.name}-${sha256(cfg.projectId).slice(0, 6)}`, 63),
          location: region,
          tier: spec.tier ?? 'standard',
          versioning: Boolean(spec.versioning),
          public_access: Boolean(spec.publicAccess),
          retention_days: retention > 0 ? retention : null,
          force_destroy: !production,
        },
      };
    }
    default:
      throw new ProviderError('GCP_CAPABILITY_NOT_IMPLEMENTED', `${req.capability} is not implemented.`, 'VALIDATION_ERROR', 'gcp');
  }
}

/** Outputs of the built in Cloud Run ingress: services publish their own HTTPS URLs. */
export function builtinIngress(req: ResourceRequest): ResourceOutputs {
  const routes = ((req.spec.routes ?? []) as { service: string }[]).map((r) => r.service);
  return { kind: 'ingress', mode: 'cloud-run', services: routes.join(',') };
}

export function rootParts(ctx: ProviderContext, req: ResourceRequest): RootParts {
  return {
    requiredProviders: {
      google: { source: 'hashicorp/google', version: '~> 8.0' },
      random: { source: 'hashicorp/random', version: '~> 3.7' },
    },
    providers: {
      google: { project: gcpConfig(ctx.target).projectId, region: ctx.region, default_labels: labelsFrom(req.tags) },
    },
  };
}
