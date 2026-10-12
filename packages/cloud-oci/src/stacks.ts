// SPDX-License-Identifier: AGPL-3.0-only
import {
  byKind,
  dependencyEnvironment,
  needKind,
  ProviderError,
  type ProviderContext,
  type ResourceRequest,
} from '@orkstage/cloud-core';
import type { ModuleCall, RootParts } from '@orkstage/cloud-tofu';
import { fitName, sha256 } from '@orkstage/domain';
import { ociConfig } from './config.js';

const MODULE_BY_CAPABILITY: Record<string, string> = {
  vcn: 'network',
  'container-instances': 'container-service',
  'oci-postgresql': 'postgres',
  'oci-cache': 'redis',
  'object-storage': 'object-storage',
  'flexible-load-balancer': 'ingress',
};

/** OCPUs and memory (GB) per logical size, on the PostgreSQL E5 flexible shape. */
export const POSTGRES_SIZE: Record<string, { ocpus: number; memoryGbs: number }> = {
  micro: { ocpus: 1, memoryGbs: 16 },
  small: { ocpus: 2, memoryGbs: 32 },
  medium: { ocpus: 4, memoryGbs: 64 },
  large: { ocpus: 8, memoryGbs: 128 },
  xlarge: { ocpus: 16, memoryGbs: 256 },
};

/** Memory per cache node (GB) per logical size. */
export const CACHE_MEMORY_GBS: Record<string, number> = { micro: 2, small: 4, medium: 8, large: 16 };

type Spec = Record<string, unknown>;

/** Freeform tag keys accept letters, digits, dashes and underscores (`platform:env` becomes `platform_env`). */
export function freeformTags(tags: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(tags).map(([k, v]) => [k.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100), String(v).slice(0, 256)]));
}

/**
 * Container instance shape from template units. One OCPU is two vCPUs; flexible shapes allow 1 to
 * 64 GB of memory per OCPU.
 */
export function containerShape(cpu: number, memoryMiB: number): { ocpus: number; memoryGbs: number } {
  const ocpus = Math.max(1, Math.ceil(cpu / 2));
  const memoryGbs = Math.min(64 * ocpus, Math.max(ocpus, Math.ceil(memoryMiB / 1024)));
  return { ocpus, memoryGbs };
}

const notImplemented = (capability: string) =>
  new ProviderError('OCI_CAPABILITY_NOT_IMPLEMENTED', `${capability} is not implemented by the OCI adapter. Choose another implementation.`, 'VALIDATION_ERROR', 'oci');

/** Module and inputs for one logical resource. */
export function moduleCall(ctx: ProviderContext, req: ResourceRequest): ModuleCall {
  const module = MODULE_BY_CAPABILITY[req.capability];
  if (!module) throw notImplemented(req.capability);
  const cfg = ociConfig(ctx.target);
  const spec = req.spec as Spec;
  const deps = req.dependencyOutputs;
  const production = req.tags['platform:environment'] === 'production';
  const common = { name: req.name, compartment_id: cfg.compartmentOcid, freeform_tags: freeformTags(req.tags) };
  const network = () => needKind('oci', deps, 'network', req.resourceId);

  switch (module) {
    case 'network': {
      const hash = sha256(req.name);
      const octet = 16 + (parseInt(hash.slice(0, 4), 16) % 200);
      // DNS labels: a letter first, letters and digits only, at most 15 characters.
      return { module, inputs: { ...common, cidr: `10.${octet}.0.0/16`, dns_label: `v${hash.slice(0, 14)}`, nat_gateway: Boolean(spec.natGateway) } };
    }
    case 'container-service': {
      const n = network();
      const ingress = byKind(deps, 'ingress');
      const privateEgress = n.private_egress === true || n.private_egress === 'true';
      const { environment, secretRefs } = dependencyEnvironment(deps);
      // Container instances cannot inject secrets as environment variables: pass the Vault secret OCID.
      for (const [key, ref] of Object.entries(secretRefs)) environment[`${key}_CREDENTIALS_REF`] = ref;
      if (spec.port) environment.PORT = String(spec.port);
      const backendSets = ingress?.backend_sets ? (JSON.parse(String(ingress.backend_sets)) as Record<string, string>) : {};
      const backendSet = backendSets[req.resourceId] ?? '';
      const shape = containerShape(Number(spec.cpu ?? 0.25), Number(spec.memoryMiB ?? 512));
      return {
        module,
        inputs: {
          ...common,
          image: spec.image,
          ocpus: shape.ocpus,
          memory_gbs: shape.memoryGbs,
          replicas: spec.replicas ?? 1,
          port: spec.port ?? null,
          vcn_id: n.vcn_id,
          vcn_cidr: n.cidr,
          subnet_id: privateEgress ? n.private_subnet_id : n.public_subnet_id,
          assign_public_ip: !privateEgress,
          public: Boolean(spec.public),
          environment,
          health_path: spec.healthCheckPath ?? '',
          load_balancer_id: backendSet ? ingress?.load_balancer_id ?? '' : '',
          backend_set_name: backendSet,
        },
      };
    }
    case 'postgres': {
      const n = network();
      const size = POSTGRES_SIZE[String(spec.size ?? 'small')] ?? POSTGRES_SIZE.small!;
      const backup = (spec.backup ?? {}) as { enabled?: boolean; retentionDays?: number };
      const retention = backup.enabled === false ? 0 : Math.min(35, Math.max(1, Number(backup.retentionDays ?? 7)));
      return {
        module,
        inputs: {
          ...common,
          db_version: String(spec.version ?? '17'),
          ocpus: size.ocpus,
          memory_gbs: size.memoryGbs,
          instance_count: spec.highAvailability && spec.highAvailability !== 'none' ? 2 : 1,
          backup_retention_days: retention,
          vcn_id: n.vcn_id,
          vcn_cidr: n.cidr,
          subnet_id: n.private_subnet_id,
          vault_id: cfg.vaultOcid ?? '',
          key_id: cfg.keyOcid ?? '',
        },
      };
    }
    case 'redis': {
      const n = network();
      return {
        module,
        inputs: {
          ...common,
          node_memory_gbs: CACHE_MEMORY_GBS[String(spec.size ?? 'micro')] ?? 2,
          node_count: 1 + Math.min(4, Math.max(0, Number(spec.replicas ?? 0))),
          vcn_id: n.vcn_id,
          vcn_cidr: n.cidr,
          subnet_id: n.private_subnet_id,
        },
      };
    }
    case 'object-storage': {
      const retention = Number(spec.retentionDays ?? 0);
      return {
        module,
        inputs: {
          ...common,
          namespace: cfg.namespace,
          region: ctx.region,
          versioning: Boolean(spec.versioning),
          tier: spec.tier ?? 'standard',
          public_access: Boolean(spec.publicAccess),
          retention_days: retention > 0 ? retention : null,
        },
      };
    }
    case 'ingress': {
      const n = network();
      const routes = ((spec.routes ?? []) as { service: string; pathPrefix?: string; healthCheckPath?: string }[]).map((r) => ({
        service: r.service,
        path_prefix: r.pathPrefix ?? '/',
        health_path: r.healthCheckPath ?? '/',
      }));
      return { module, inputs: { ...common, name: fitName(req.name, 200), subnet_id: n.public_subnet_id, routes, production } };
    }
    default:
      throw notImplemented(req.capability);
  }
}

/** Provider blocks. The private key reaches the provider only as TF_VAR_oci_private_key. */
export function rootParts(ctx: ProviderContext): RootParts {
  const cfg = ociConfig(ctx.target);
  return {
    requiredProviders: {
      oci: { source: 'oracle/oci', version: '~> 9.0' },
      random: { source: 'hashicorp/random', version: '~> 3.7' },
    },
    providers: {
      oci: {
        tenancy_ocid: cfg.tenancyOcid,
        user_ocid: cfg.userOcid,
        fingerprint: cfg.fingerprint,
        region: ctx.region,
        private_key: '${var.oci_private_key}',
      },
    },
    variables: { oci_private_key: { type: 'string', sensitive: true } },
  };
}
