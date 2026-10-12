// SPDX-License-Identifier: AGPL-3.0-only
import { byKind, dependencyEnvironment, ProviderError, type ProviderContext, type ResourceRequest } from '@orkstage/cloud-core';
import type { ModuleCall, RootParts } from '@orkstage/cloud-tofu';
import { fitName, sha256 } from '@orkstage/domain';
import { coreweaveConfig, labelsFrom } from './config.js';

/** Module directory per capability. */
export const MODULE_BY_CAPABILITY: Record<string, string> = {
  vpc: 'network',
  'cks-deployment': 'container-service',
  'ai-object-storage': 'object-storage',
  'cks-ingress': 'ingress',
};

/** Service kinds that run inside the target's CKS cluster and need Kubernetes API access. */
export const CLUSTER_KINDS = new Set(['compute.container-service', 'ingress']);

const PROVIDERS = {
  coreweave: { source: 'coreweave/coreweave', version: '~> 0.24.0' },
  kubernetes: { source: 'hashicorp/kubernetes', version: '~> 3.3' },
};

/** GPU request from `providerOverrides.coreweave.gpu`. */
export interface GpuRequest {
  count: number;
  /** Value of the `gpu.nvidia.com/class` node label, e.g. `H100_NVLINK_80GB`. */
  class?: string;
}

type Spec = Record<string, unknown>;

export function gpuFrom(spec: Spec): GpuRequest | null {
  const gpu = (spec.providerOverrides as { coreweave?: { gpu?: { count?: unknown; class?: unknown } } } | undefined)?.coreweave?.gpu;
  if (!gpu) return null;
  const count = Number(gpu.count ?? 1);
  if (!Number.isInteger(count) || count < 1 || count > 8) {
    throw new ProviderError('COREWEAVE_GPU_INVALID', 'providerOverrides.coreweave.gpu.count must be a whole number from 1 to 8.', 'VALIDATION_ERROR', 'coreweave');
  }
  const cls = gpu.class === undefined ? undefined : String(gpu.class);
  if (cls !== undefined && !/^[A-Za-z0-9_.-]{1,63}$/.test(cls)) {
    throw new ProviderError('COREWEAVE_GPU_INVALID', 'providerOverrides.coreweave.gpu.class must be a gpu.nvidia.com/class label value such as H100_NVLINK_80GB.', 'VALIDATION_ERROR', 'coreweave');
  }
  return { count, ...(cls ? { class: cls } : {}) };
}

/** Template `autoscaling` as a HorizontalPodAutoscaler setting, or null for fixed replicas. */
export function autoscalingFrom(spec: Spec): { min_replicas: number; max_replicas: number; target_cpu_percent: number } | null {
  const a = spec.autoscaling as { minReplicas: number; maxReplicas: number; targetCpuPercent: number } | undefined;
  if (!a) return null;
  return { min_replicas: Math.max(1, a.minReplicas), max_replicas: Math.max(1, a.maxReplicas, a.minReplicas), target_cpu_percent: a.targetCpuPercent };
}

/** Second octet of the VPC prefixes, stable per name (10.100.x.x to 10.199.x.x). */
export function vpcOctet(name: string): number {
  return 100 + (parseInt(sha256(name).slice(0, 4), 16) % 100);
}

export function moduleCall(ctx: ProviderContext, req: ResourceRequest): ModuleCall {
  const module = MODULE_BY_CAPABILITY[req.capability];
  if (!module) {
    throw new ProviderError('COREWEAVE_CAPABILITY_NOT_IMPLEMENTED', `${req.capability} is not implemented by the CoreWeave adapter. Choose another implementation or place ${req.resourceId} on another provider.`, 'VALIDATION_ERROR', 'coreweave');
  }
  const cfg = coreweaveConfig(ctx.target);
  const spec = req.spec as Spec;
  const deps = req.dependencyOutputs;

  switch (module) {
    case 'network': {
      const o = vpcOctet(req.name);
      return {
        module,
        inputs: {
          name: fitName(req.name, 30),
          zone: ctx.region,
          pod_cidr: `10.${o}.0.0/17`,
          service_cidr: `10.${o}.128.0/22`,
          internal_lb_cidr: `10.${o}.132.0/22`,
        },
      };
    }
    case 'container-service': {
      const ingress = byKind(deps, 'ingress');
      const routes = ingress?.routes ? (JSON.parse(String(ingress.routes)) as Record<string, string>) : {};
      const pathPrefix = routes[req.resourceId];
      const port = spec.port === undefined || spec.port === null ? null : Number(spec.port);
      if ((spec.public || pathPrefix) && port === null) {
        throw new ProviderError('COREWEAVE_PORT_REQUIRED', `${req.resourceId} is public or routed by an ingress, so it needs a port.`, 'VALIDATION_ERROR', 'coreweave');
      }
      const { environment } = dependencyEnvironment(deps);
      if (port !== null) environment.PORT = String(port);
      return {
        module,
        inputs: {
          name: fitName(req.name, 63),
          image: spec.image,
          replicas: Number(spec.replicas ?? 1),
          cpu_millicores: Math.max(1, Math.round(Number(spec.cpu ?? 0.25) * 1000)),
          memory_mib: Number(spec.memoryMiB ?? 512),
          port,
          public: Boolean(spec.public),
          health_check_path: spec.healthCheckPath ?? null,
          environment,
          secret_env: '${var.secret_env}',
          labels: labelsFrom(req.tags),
          gpu: gpuFrom(spec),
          autoscaling: autoscalingFrom(spec),
          route:
            pathPrefix && ingress
              ? {
                  host: String(ingress.host),
                  path_prefix: pathPrefix,
                  ingress_class: String(ingress.ingress_class),
                  tls: ingress.tls === true || ingress.tls === 'true',
                  cluster_issuer: String(ingress.cluster_issuer ?? ''),
                }
              : null,
        },
      };
    }
    case 'object-storage':
      return {
        module,
        inputs: {
          name: fitName(req.name, 50),
          zone: ctx.region,
          versioning: Boolean(spec.versioning),
          retention_days: spec.retentionDays ?? null,
          tags: labelsFrom(req.tags),
        },
      };
    case 'ingress': {
      if (!cfg.ingressDomain && !cfg.clusterName) {
        throw new ProviderError('COREWEAVE_INGRESS_DOMAIN', 'cks-ingress needs clusterName or ingressDomain in the target configuration to build its host name.', 'VALIDATION_ERROR', 'coreweave');
      }
      const routes = Object.fromEntries(((spec.routes ?? []) as { service: string; pathPrefix?: string }[]).map((r) => [r.service, r.pathPrefix ?? '/']));
      return {
        module,
        inputs: {
          name: fitName(req.name, 63),
          host_label: fitName(req.name, 63),
          domain: cfg.ingressDomain ?? '',
          cluster_name: cfg.clusterName ?? '',
          ingress_class: cfg.ingressClassName ?? 'traefik',
          cluster_issuer: cfg.clusterIssuer ?? 'letsencrypt-prod',
          tls: spec.tls !== false,
          routes: JSON.stringify(routes),
          labels: labelsFrom(req.tags),
        },
      };
    }
    default:
      throw new ProviderError('COREWEAVE_CAPABILITY_NOT_IMPLEMENTED', `${req.capability} is not implemented.`, 'VALIDATION_ERROR', 'coreweave');
  }
}

/**
 * Providers per module. The coreweave provider reads COREWEAVE_API_TOKEN; the kubernetes provider
 * reads the cluster endpoint, token and CA from root variables filled through TF_VAR_* by the
 * runner, so no kubeconfig file is ever written.
 */
export function rootParts(_ctx: ProviderContext, req: ResourceRequest): RootParts {
  const module = MODULE_BY_CAPABILITY[req.capability];
  const usesCoreWeave = module !== 'container-service';
  const usesKubernetes = CLUSTER_KINDS.has(req.serviceKind);
  return {
    requiredProviders: {
      ...(usesCoreWeave ? { coreweave: PROVIDERS.coreweave } : {}),
      ...(usesKubernetes ? { kubernetes: PROVIDERS.kubernetes } : {}),
    },
    providers: {
      ...(usesCoreWeave ? { coreweave: {} } : {}),
      ...(usesKubernetes
        ? { kubernetes: { host: '${var.k8s_host}', token: '${var.k8s_token}', cluster_ca_certificate: '${var.k8s_ca == "" ? null : var.k8s_ca}' } }
        : {}),
    },
    variables: usesKubernetes
      ? {
          k8s_host: { type: 'string' },
          k8s_token: { type: 'string', sensitive: true },
          k8s_ca: { type: 'string' },
          ...(module === 'container-service' ? { secret_env: { type: 'map(string)', sensitive: true } } : {}),
        }
      : {},
  };
}
