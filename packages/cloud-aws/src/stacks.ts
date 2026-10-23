// SPDX-License-Identifier: AGPL-3.0-only
import { ProviderError, type ProviderContext, type ResourceOutputs, type ResourceRequest } from '@orkstage/cloud-core';
import { fitName, sha256 } from '@orkstage/domain';
import { awsConfig, EMULATED_SERVICES, isEmulator, stateBucketFor, stateRegionFor } from './config.js';

const MODULE_BY_CAPABILITY: Record<string, string> = {
  vpc: 'network',
  ecr: 'container-registry',
  alb: 'ingress',
  'ecs-fargate': 'container-service',
  'ecs-ec2': 'container-service',
  'rds-postgres': 'postgres',
  'elasticache-valkey': 'redis',
  sqs: 'queue',
  s3: 'object-storage',
  route53: 'dns',
};

const RDS_CLASS: Record<string, string> = {
  micro: 'db.t4g.micro',
  small: 'db.t4g.small',
  medium: 'db.t4g.medium',
  large: 'db.r7g.large',
  xlarge: 'db.r7g.xlarge',
};

const CACHE_NODE: Record<string, string> = {
  micro: 'cache.t4g.micro',
  small: 'cache.t4g.small',
  medium: 'cache.t4g.medium',
  large: 'cache.r7g.large',
};

export function stateKeyFor(name: string): string {
  return `orkstage/${name}.tfstate`;
}

/**
 * Where a resource's state lives (A5). The default bucket belongs to one account and region, so
 * the plain key never collides. A custom bucket serves every region of the target: a new state gets
 * the region in its key, and a state written before that keeps its key.
 */
export function chooseStateKey(customBucket: boolean, existsAtPlainKey: boolean, region: string, name: string): string {
  return !customBucket || existsAtPlainKey ? stateKeyFor(name) : `orkstage/${region}/${name}.tfstate`;
}

type Spec = Record<string, unknown>;
type Deps = Record<string, ResourceOutputs>;

function byKind(deps: Deps, kind: string): ResourceOutputs | undefined {
  return Object.values(deps).find((o) => o.kind === kind);
}

function need(deps: Deps, kind: string, forWhat: string): ResourceOutputs {
  const found = byKind(deps, kind);
  if (!found) throw new ProviderError('AWS_MISSING_DEPENDENCY', `${forWhat} needs a ${kind} in the same placement slot.`, 'VALIDATION_ERROR', 'aws');
  return found;
}

const list = (v: unknown) => String(v ?? '').split(',').filter(Boolean);
const envKey = (resourceId: string) => resourceId.toUpperCase().replace(/[^A-Z0-9]/g, '_');

/** Module inputs for one logical resource. Everything here is provider-specific by design. */
export function moduleInputs(ctx: ProviderContext, req: ResourceRequest): { module: string; inputs: Record<string, unknown> } {
  const module = MODULE_BY_CAPABILITY[req.capability];
  if (!module) {
    throw new ProviderError('AWS_CAPABILITY_NOT_IMPLEMENTED', `${req.capability} is not implemented by the AWS adapter yet. Choose another implementation.`, 'VALIDATION_ERROR', 'aws');
  }
  const cfg = awsConfig(ctx.target);
  const spec = req.spec as Spec;
  const deps = req.dependencyOutputs;
  const production = req.tags['platform:environment'] === 'production';
  const network = () => need(deps, 'network', req.resourceId);

  switch (module) {
    case 'network': {
      const octet = 16 + (parseInt(sha256(req.name).slice(0, 4), 16) % 200);
      return { module, inputs: { name: fitName(req.name, 200), cidr: `10.${octet}.0.0/16`, az_count: spec.availabilityZones ?? 2, nat_gateway: Boolean(spec.natGateway) } };
    }
    case 'container-registry':
      return { module, inputs: { name: fitName(req.name, 200), scan_on_push: spec.scanOnPush ?? true, immutable_tags: spec.immutableTags ?? true, force_delete: !production } };
    case 'ingress': {
      const n = network();
      const routes = ((spec.routes ?? []) as { service: string; pathPrefix?: string; port?: number; healthCheckPath?: string }[]).map((r) => ({
        service: r.service,
        path_prefix: r.pathPrefix ?? '/',
        port: r.port ?? 80,
        health_path: r.healthCheckPath ?? '/',
      }));
      return {
        module,
        inputs: {
          name: fitName(req.name, 32),
          vpc_id: n.vpc_id,
          public_subnet_ids: list(n.public_subnet_ids),
          routes,
          emulator_base_url: isEmulator(cfg) ? (cfg.publicEndpointUrl ?? cfg.endpointUrl) : '',
        },
      };
    }
    case 'container-service': {
      const n = network();
      const ingress = byKind(deps, 'ingress');
      const privateEgress = n.private_egress === true || n.private_egress === 'true';
      const environment: Record<string, string> = { PORT: String(spec.port ?? '') };
      const secrets: Record<string, string> = {};
      for (const [id, out] of Object.entries(deps)) {
        if (['network', 'container-registry', 'ingress', 'dns'].includes(String(out.kind))) continue;
        const key = envKey(id);
        if (out.host) environment[`${key}_HOST`] = String(out.host);
        if (out.port) environment[`${key}_PORT`] = String(out.port);
        if (out.queue_url) environment[`${key}_URL`] = String(out.queue_url);
        if (out.bucket) environment[`${key}_BUCKET`] = String(out.bucket);
        if (out.endpoint) environment[`${key}_ENDPOINT`] = String(out.endpoint);
        if (out.secret_ref) {
          // ECS reads only Secrets Manager (or SSM) ARNs. A reference owned by another provider (Key
          // Vault, Secret Manager, a platform) is passed as a reference, never as a value.
          const ref = String(out.secret_ref);
          if (/^arn:aws[a-z-]*:(secretsmanager|ssm):/.test(ref)) secrets[`${key}_CREDENTIALS`] = ref;
          // Another provider's credentials: copied into this service's own secret (externalSecretIds).
        }
        // Simulated (non-AWS) dependencies expose camelCase outputs; pass their references too.
        if (out.secretRef) environment[`${key}_CREDENTIALS_REF`] = String(out.secretRef);
        if (out.queueUrl) environment[`${key}_URL`] = String(out.queueUrl);
      }
      const targetGroups = ingress?.target_groups ? (JSON.parse(String(ingress.target_groups)) as Record<string, string>) : {};
      const overrides = (spec.providerOverrides as { aws?: { capacity?: string } } | undefined)?.aws;
      return {
        module,
        inputs: {
          name: fitName(req.name, 200),
          capacity: req.capability === 'ecs-ec2' ? 'EC2' : overrides?.capacity === 'FARGATE_SPOT' ? 'FARGATE_SPOT' : 'FARGATE',
          image: spec.image,
          cpu: spec.cpu ?? 0.25,
          memory_mib: spec.memoryMiB ?? 512,
          replicas: spec.replicas ?? 1,
          port: spec.port ?? null,
          vpc_id: n.vpc_id,
          vpc_cidr: n.cidr,
          subnet_ids: list(privateEgress ? n.private_subnet_ids : n.public_subnet_ids),
          assign_public_ip: !privateEgress,
          environment,
          secrets,
          target_group_arn: targetGroups[req.resourceId] ?? '',
          lb_sg_id: ingress?.lb_sg_id ?? '',
          ec2_ami_id: cfg.ecsAmiId ?? (isEmulator(cfg) ? 'ami-0emulated0000000' : ''),
          autoscaling: serviceAutoscaling(spec, isEmulator(cfg)),
          // Policy minimum (open item 12); the module default otherwise.
          ...(typeof spec.logRetentionDays === 'number' ? { log_retention_days: cloudWatchRetention(spec.logRetentionDays) } : {}),
        },
      };
    }
    case 'postgres': {
      const n = network();
      const backup = (spec.backup ?? {}) as { enabled?: boolean; retentionDays?: number };
      return {
        module,
        inputs: {
          name: fitName(req.name, 63),
          engine_version: String(spec.version ?? '17'),
          instance_class: RDS_CLASS[String(spec.size ?? 'small')] ?? 'db.t4g.small',
          storage_gib: Math.max(20, Number(spec.storageGiB ?? 20)),
          multi_az: spec.highAvailability === 'zone-redundant',
          backup_retention_days: backup.enabled ? backup.retentionDays ?? 7 : 0,
          production,
          vpc_id: n.vpc_id,
          vpc_cidr: n.cidr,
          subnet_ids: list(n.private_subnet_ids),
        },
      };
    }
    case 'redis': {
      const n = network();
      return {
        module,
        inputs: {
          name: fitName(req.name, 40),
          node_type: CACHE_NODE[String(spec.size ?? 'micro')] ?? 'cache.t4g.micro',
          replicas: spec.replicas ?? 0,
          vpc_id: n.vpc_id,
          vpc_cidr: n.cidr,
          subnet_ids: list(n.private_subnet_ids),
        },
      };
    }
    case 'queue':
      return { module, inputs: { name: fitName(req.name, 70), fifo: Boolean(spec.fifo), dead_letter: spec.deadLetter ?? true } };
    case 'object-storage':
      return {
        module,
        inputs: {
          name: fitName(req.name, 50),
          versioning: Boolean(spec.versioning),
          tier: spec.tier ?? 'standard',
          retention_days: spec.retentionDays ?? null,
          force_destroy: !production,
          access_keys: Boolean(spec.accessKeys),
          production,
        },
      };
    case 'dns': {
      const ingress = need(deps, 'ingress', req.resourceId);
      const tgs = ingress.target_groups ? Object.values(JSON.parse(String(ingress.target_groups)) as Record<string, string>) : [];
      return {
        module,
        inputs: {
          zone_name: cfg.dnsZone ?? 'orkstage.local',
          create_zone: Boolean(cfg.createDnsZone),
          record_label: fitName(String(spec.subdomainLabel ?? req.name), 63),
          lb_dns_name: ingress.dns_name,
          lb_zone_id: ingress.zone_id,
          lb_arn: ingress.arn,
          default_target_group_arn: tgs[0] ?? '',
          tls: true,
          custom_domains: Array.isArray(spec.customDomains) ? spec.customDomains : [],
          ssl_policy: spec.minTlsVersion === '1.3' ? 'ELBSecurityPolicy-TLS13-1-3-2021-06' : 'ELBSecurityPolicy-TLS13-1-2-2021-06',
          attach_custom_certificate: spec.customCertificateIssued === true,
        },
      };
    }
    default:
      throw new ProviderError('AWS_CAPABILITY_NOT_IMPLEMENTED', `${req.capability} is not implemented.`, 'VALIDATION_ERROR', 'aws');
  }
}

/**
 * Dependencies of a container service whose credentials live in another provider's secret store:
 * their values reach the module's `external_secrets` through TF_VAR_external_secrets (open item 4).
 */
export function externalSecretIds(req: ResourceRequest): string[] {
  if (MODULE_BY_CAPABILITY[req.capability] !== 'container-service') return [];
  return Object.entries(req.dependencyOutputs)
    .filter(([, o]) => typeof o.secret_ref === 'string' && o.secret_ref && !/^arn:aws[a-z-]*:(secretsmanager|ssm):/.test(o.secret_ref))
    .map(([id]) => id);
}

/** Complete root configuration (OpenTofu JSON syntax) for one resource's isolated state. */
export function rootConfig(ctx: ProviderContext, req: ResourceRequest, stateKey = stateKeyFor(req.name)): Record<string, unknown> {
  const cfg = awsConfig(ctx.target);
  const { module, inputs } = moduleInputs(ctx, req);
  const external = externalSecretIds(req).length > 0;
  const emulator = isEmulator(cfg);
  const runnerEndpoint = cfg.runnerEndpointUrl ?? cfg.endpointUrl;
  const skip = emulator
    ? { skip_credentials_validation: true, skip_requesting_account_id: true, skip_metadata_api_check: true }
    : {};

  return {
    terraform: {
      required_version: '>= 1.11',
      required_providers: {
        aws: { source: 'hashicorp/aws', version: '~> 6.0' },
        random: { source: 'hashicorp/random', version: '~> 3.7' },
      },
      backend: {
        s3: {
          bucket: stateBucketFor(cfg, ctx.region),
          key: stateKey,
          region: stateRegionFor(ctx.target, ctx.region),
          encrypt: true,
          use_lockfile: true,
          ...(emulator ? { ...skip, skip_region_validation: true, use_path_style: true, endpoints: { s3: runnerEndpoint } } : {}),
        },
      },
    },
    provider: {
      aws: {
        region: ctx.region,
        default_tags: { tags: req.tags },
        ...(emulator
          ? { ...skip, s3_use_path_style: true, endpoints: Object.fromEntries(EMULATED_SERVICES.map((s) => [s, runnerEndpoint])) }
          : {}),
      },
    },
    ...(external ? { variable: { external_secrets: { type: 'map(string)', sensitive: true, default: {} } } } : {}),
    module: { resource: { source: `/modules/aws/${module}`, ...inputs, ...(external ? { external_secrets: '${var.external_secrets}' } : {}) } },
    output: { all: { value: '${module.resource}' } },
  };
}

export function flattenOutputs(all: unknown): ResourceOutputs {
  const out: ResourceOutputs = {};
  for (const [k, v] of Object.entries((all ?? {}) as Record<string, unknown>)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
  }
  return out;
}

/**
 * Template `autoscaling` → module input. Emulators do not implement Application Auto Scaling, so
 * there the service runs with fixed `replicas` (the adapter logs that).
 */
export function serviceAutoscaling(spec: Spec, emulator: boolean): { min_replicas: number; max_replicas: number; target_cpu_percent: number } | null {
  const a = spec.autoscaling as { minReplicas: number; maxReplicas: number; targetCpuPercent: number } | undefined;
  if (!a || emulator) return null;
  return { min_replicas: a.minReplicas, max_replicas: a.maxReplicas, target_cpu_percent: a.targetCpuPercent };
}

/** Retention periods CloudWatch Logs accepts; a minimum is rounded up to the next one. */
const CLOUDWATCH_RETENTION = [1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653];

export function cloudWatchRetention(days: number): number {
  return CLOUDWATCH_RETENTION.find((d) => d >= days) ?? 3653;
}
