// SPDX-License-Identifier: AGPL-3.0-only
import { dependencyEnvironment, needKind, ProviderError, type ProviderContext, type ResourceRequest } from '@orkstage/cloud-core';
import type { ModuleCall, RootParts } from '@orkstage/cloud-tofu';
import { fitName, sha256 } from '@orkstage/domain';
import { magaluConfig } from './config.js';

const MODULE_BY_CAPABILITY: Record<string, string> = {
  vpc: 'network',
  'vm-docker': 'container-service',
  'dbaas-postgres': 'postgres',
  'object-storage': 'object-storage',
};

/** Logical database size to the minimum DBaaS shape; the module picks the smallest fitting type. */
const DB_SHAPE: Record<string, { vcpu: number; ramGib: number; family: 'BV' | 'DP' }> = {
  micro: { vcpu: 1, ramGib: 1, family: 'BV' },
  small: { vcpu: 2, ramGib: 4, family: 'BV' },
  medium: { vcpu: 4, ramGib: 8, family: 'BV' },
  large: { vcpu: 4, ramGib: 16, family: 'DP' },
  xlarge: { vcpu: 8, ramGib: 32, family: 'DP' },
};

/** Root variables that carry secrets from `TF_VAR_*` runner environment variables to the provider. */
export const SECRET_VARIABLES = ['mgc_api_key', 'mgc_key_pair_id', 'mgc_key_pair_secret'] as const;

type Spec = Record<string, unknown>;
type MagaluOverrides = { machineType?: string; vmImage?: string; instanceType?: string };

const overridesOf = (spec: Spec): MagaluOverrides => ((spec.providerOverrides as Record<string, MagaluOverrides> | undefined)?.magalu ?? {});

/** Module and inputs for one logical resource on Magalu Cloud. */
export function moduleCall(ctx: ProviderContext, req: ResourceRequest): ModuleCall {
  const module = MODULE_BY_CAPABILITY[req.capability];
  if (!module) {
    throw new ProviderError('MAGALU_CAPABILITY_NOT_IMPLEMENTED', `${req.capability} is not implemented by the Magalu Cloud adapter. Choose another implementation.`, 'VALIDATION_ERROR', 'magalu');
  }
  const spec = req.spec as Spec;
  const deps = req.dependencyOutputs;
  const production = req.tags['platform:environment'] === 'production';
  const overrides = overridesOf(spec);

  switch (module) {
    case 'network': {
      const octet = 16 + (parseInt(sha256(req.name).slice(0, 4), 16) % 200);
      return { module, inputs: { name: fitName(req.name, 63), cidr: `10.${octet}.0.0/16` } };
    }
    case 'container-service': {
      const n = needKind('magalu', deps, 'network', req.resourceId);
      const { environment, secretRefs } = dependencyEnvironment(deps);
      for (const [key, ref] of Object.entries(secretRefs)) environment[`${key}_CREDENTIALS_REF`] = ref;
      const port = typeof spec.port === 'number' ? spec.port : null;
      if (port !== null) environment.PORT = String(port);
      const replicas = Number(spec.replicas ?? 1);
      const isPublic = Boolean(spec.public);
      if (spec.autoscaling) ctx.log?.('warn', `${req.resourceId}: autoscaling is not available on Magalu Cloud VMs; running ${replicas} fixed replica(s).`);
      return {
        module,
        inputs: {
          name: fitName(req.name, 40),
          image: spec.image,
          replicas,
          min_vcpu: Math.max(1, Math.ceil(Number(spec.cpu ?? 0.25))),
          min_ram_gib: Math.max(1, Math.ceil(Number(spec.memoryMiB ?? 512) / 1024)),
          machine_type: overrides.machineType ?? '',
          ...(overrides.vmImage ? { vm_image: overrides.vmImage } : {}),
          port,
          public: isPublic,
          health_path: String(spec.healthCheckPath ?? '/'),
          load_balancer: isPublic && replicas > 1 && port !== null,
          vpc_id: n.vpc_id,
          vpc_cidr: n.cidr,
          subnet_id: n.subnet_id,
          subnetpool_id: n.subnetpool_id,
          availability_zone: n.availability_zone,
          internal_sg_id: n.internal_sg_id,
          environment,
          ssh_key_name: magaluConfig(ctx.target).sshKeyName ?? '',
        },
      };
    }
    case 'postgres': {
      const size = String(spec.size ?? 'small');
      const shape = DB_SHAPE[size] ?? DB_SHAPE.small!;
      const backup = (spec.backup ?? {}) as { enabled?: boolean; retentionDays?: number };
      if (spec.highAvailability === 'same-zone') ctx.log?.('warn', `${req.resourceId}: same zone HA is not offered by Magalu Cloud DBaaS; creating a single instance.`);
      if (spec.publicAccess) ctx.log?.('warn', `${req.resourceId}: Magalu Cloud DBaaS is reachable on a private address only.`);
      return {
        module,
        inputs: {
          name: fitName(req.name, 48),
          engine_version: String(spec.version ?? '16'),
          min_vcpu: shape.vcpu,
          min_ram_gib: shape.ramGib,
          family: shape.family,
          instance_type: overrides.instanceType ?? '',
          volume_size_gib: Math.max(20, Number(spec.storageGiB ?? 20)),
          // DBaaS always keeps automated backups; disabling them keeps the minimum of one day.
          backup_retention_days: backup.enabled === false ? 1 : Math.min(35, Math.max(1, backup.retentionDays ?? 7)),
          high_availability: spec.highAvailability === 'zone-redundant',
          production,
        },
      };
    }
    case 'object-storage':
      return { module, inputs: { name: fitName(req.name, 63), region: ctx.region, versioning: Boolean(spec.versioning) } };
    default:
      throw new ProviderError('MAGALU_CAPABILITY_NOT_IMPLEMENTED', `${req.capability} is not implemented.`, 'VALIDATION_ERROR', 'magalu');
  }
}

/** Provider requirements and the `mgc` provider block. Secrets are variables, never values. */
export function rootParts(ctx: ProviderContext, req: ResourceRequest): RootParts {
  const module = MODULE_BY_CAPABILITY[req.capability];
  return {
    requiredProviders: {
      mgc: { source: 'MagaluCloud/mgc', version: '~> 0.56.0' },
      ...(module === 'postgres' ? { random: { source: 'hashicorp/random', version: '~> 3.7' } } : {}),
      ...(module === 'container-service' ? { tls: { source: 'hashicorp/tls', version: '~> 4.1' } } : {}),
    },
    providers: {
      mgc: {
        region: ctx.region,
        api_key: '${var.mgc_api_key}',
        key_pair_id: '${var.mgc_key_pair_id}',
        key_pair_secret: '${var.mgc_key_pair_secret}',
      },
    },
    variables: Object.fromEntries(SECRET_VARIABLES.map((v) => [v, { type: 'string', sensitive: true }])),
  };
}
