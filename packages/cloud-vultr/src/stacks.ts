// SPDX-License-Identifier: AGPL-3.0-only
import { ProviderError, byKind, dependencyEnvironment, needKind, type ProviderContext, type ResourceRequest } from '@orkstage/cloud-core';
import type { ModuleCall, RootParts } from '@orkstage/cloud-tofu';
import { fitName, sha256 } from '@orkstage/domain';
import { instancePlan } from './sizing.js';

/** Provider versions verified against the registry (vultr/vultr 2.33.1, October 2026). */
export const VULTR_PROVIDER = { source: 'vultr/vultr', version: '~> 2.30' };

/** Prefixes of the `secret_ref` values Vultr modules publish. */
export const DB_REF = 'vultr-db://';
export const OBJSTORE_REF = 'vultr-objstore://';

const MODULE_BY_CAPABILITY: Record<string, string> = {
  vpc: 'network',
  'instance-docker': 'container-service',
  'managed-postgres': 'postgres',
  'managed-valkey': 'redis',
  'object-storage': 'object-storage',
  'load-balancer': 'ingress',
};

/** Values the adapter looks up through the Vultr API before rendering (plans, storage cluster). */
export interface VultrResolved {
  plan?: string;
  sizeKey?: string;
  clusterId?: number;
  tierId?: number;
}

/** `providerOverrides.vultr` from the template (admin only escape hatch). */
export interface VultrOverrides {
  plan?: string;
  engineVersion?: string;
  timeZone?: string;
  clusterId?: number;
  tierId?: number;
  autoSslDomain?: string;
  /** false keeps database and storage credentials out of instance user data. */
  injectCredentials?: boolean;
}

type Spec = Record<string, unknown>;

export function overridesOf(spec: Spec): VultrOverrides {
  return ((spec.providerOverrides as Record<string, unknown> | undefined)?.vultr ?? {}) as VultrOverrides;
}

export const resolvedOf = (spec: Spec) => (spec.vultrResolved ?? {}) as VultrResolved;

const invalid = (code: string, message: string) => new ProviderError(code, message, 'VALIDATION_ERROR', 'vultr');

/** Vultr tags are free text; keep them readable and free of separators Vultr may reject. */
export function vultrTags(tags: Record<string, string>): string[] {
  return Object.entries(tags).map(([k, v]) => `${k.replace(/[^A-Za-z0-9_-]/g, '_')}=${v.replace(/[^A-Za-z0-9_.-]/g, '_')}`);
}

interface Route {
  service: string;
  pathPrefix?: string;
  port?: number;
  healthCheckPath?: string;
}

/**
 * Checks an ingress against what a Vultr load balancer can do: it has no path routing and one
 * health check for all attached instances, so it serves exactly one service.
 */
export function singleRoute(spec: Spec): Required<Pick<Route, 'service' | 'port'>> & { healthPath: string } {
  const routes = (spec.routes ?? []) as Route[];
  if (!routes.length) throw invalid('VULTR_INGRESS_INVALID', 'An ingress needs at least one route.');
  const services = [...new Set(routes.map((r) => r.service))];
  if (services.length > 1) {
    throw invalid('VULTR_INGRESS_UNSUPPORTED', `A Vultr load balancer sends traffic to one service only (it has one health check for all instances). Create one ingress per service instead of routing ${services.join(', ')} together.`);
  }
  const pathed = routes.filter((r) => (r.pathPrefix ?? '/') !== '/');
  if (pathed.length) {
    throw invalid('VULTR_INGRESS_UNSUPPORTED', `Vultr load balancers do not route by path. Use pathPrefix "/" (found ${pathed.map((r) => r.pathPrefix).join(', ')}).`);
  }
  const route = routes[0]!;
  if (!route.port) throw invalid('VULTR_INGRESS_INVALID', `Service ${route.service} is routed by this ingress but declares no port.`);
  return { service: route.service, port: route.port, healthPath: route.healthCheckPath ?? '/' };
}

/** Module and inputs for one logical resource. */
export function vultrModuleCall(ctx: ProviderContext, req: ResourceRequest): ModuleCall {
  const module = MODULE_BY_CAPABILITY[req.capability];
  if (!module) {
    throw invalid('VULTR_CAPABILITY_NOT_IMPLEMENTED', `${req.capability} is not implemented by the Vultr adapter. Choose another implementation.`);
  }
  const spec = req.spec as Spec;
  const deps = req.dependencyOutputs;
  const ov = overridesOf(spec);
  const resolved = resolvedOf(spec);
  const network = () => needKind('vultr', deps, 'network', req.resourceId);
  const needResolved = (field: keyof VultrResolved) => {
    if (resolved[field] === undefined) throw invalid('VULTR_NOT_RESOLVED', `${req.capability} needs ${field}, looked up from the Vultr API before rendering.`);
    return resolved[field];
  };

  switch (module) {
    case 'network': {
      const octet = 16 + (parseInt(sha256(req.name).slice(0, 4), 16) % 200);
      return { module, inputs: { name: fitName(req.name, 255), region: ctx.region, v4_subnet: `10.${octet}.0.0`, v4_subnet_mask: 20 } };
    }
    case 'container-service': {
      const n = network();
      const ingress = byKind(deps, 'ingress');
      const attached = ingress && ingress.service === req.resourceId ? ingress : undefined;
      const { environment, secretRefs } = dependencyEnvironment(deps);
      const inject = ov.injectCredentials !== false;
      const databaseRefs: Record<string, string> = {};
      const storageRefs: Record<string, string> = {};
      for (const [key, ref] of Object.entries(secretRefs)) {
        if (inject && ref.startsWith(DB_REF)) databaseRefs[key] = ref.slice(DB_REF.length);
        else if (inject && ref.startsWith(OBJSTORE_REF)) storageRefs[key] = ref.slice(OBJSTORE_REF.length);
        else {
          environment[`${key}_CREDENTIALS_REF`] = ref;
          if (inject) ctx.log?.('warn', `${key} credentials come from another provider and are not injected into the instances; the service receives ${key}_CREDENTIALS_REF only.`);
        }
      }
      const autoscaling = spec.autoscaling as { minReplicas?: number } | undefined;
      let replicas = Number(spec.replicas ?? 1);
      if (autoscaling) {
        replicas = Math.max(replicas, autoscaling.minReplicas ?? 0);
        ctx.log?.('warn', `Vultr instances do not autoscale; ${req.resourceId} runs ${replicas} instance(s).`);
      }
      if (!spec.image) throw invalid('VULTR_IMAGE_MISSING', `${req.resourceId} has no image.`);
      const cpu = Number(spec.cpu ?? 0.25);
      const memoryMiB = Number(spec.memoryMiB ?? 512);
      return {
        module,
        inputs: {
          name: fitName(req.name, 48),
          region: ctx.region,
          plan: ov.plan ?? instancePlan(cpu, memoryMiB),
          image: spec.image,
          cpu,
          memory_mib: memoryMiB,
          replicas,
          port: spec.port ?? null,
          public: Boolean(spec.public),
          vpc_id: n.network_id,
          vpc_cidr: n.cidr,
          environment,
          tags: vultrTags(req.tags),
          lb_id: attached?.lb_id ?? '',
          ingress_url: attached?.url ?? '',
          inject_credentials: inject && Object.keys(databaseRefs).length + Object.keys(storageRefs).length > 0,
          database_refs: databaseRefs,
          object_storage_refs: storageRefs,
        },
      };
    }
    case 'postgres': {
      const n = network();
      return {
        module,
        inputs: {
          name: fitName(req.name, 48),
          region: ctx.region,
          plan: needResolved('plan'),
          size_key: needResolved('sizeKey'),
          engine_version: String(ov.engineVersion ?? spec.version ?? '17'),
          vpc_id: n.network_id,
          vpc_cidr: n.cidr,
          public_access: Boolean(spec.publicAccess),
          cluster_time_zone: ov.timeZone ?? 'UTC',
          tag: 'orkstage',
        },
      };
    }
    case 'redis': {
      const n = network();
      return {
        module,
        inputs: {
          name: fitName(req.name, 48),
          region: ctx.region,
          plan: needResolved('plan'),
          size_key: needResolved('sizeKey'),
          engine_version: String(ov.engineVersion ?? '7'),
          vpc_id: n.network_id,
          vpc_cidr: n.cidr,
          tag: 'orkstage',
        },
      };
    }
    case 'object-storage':
      return {
        module,
        inputs: {
          name: fitName(req.name, 63),
          cluster_id: needResolved('clusterId'),
          tier_id: needResolved('tierId'),
          versioning: Boolean(spec.versioning),
        },
      };
    case 'ingress': {
      const n = network();
      const route = singleRoute(spec);
      if (spec.tls && !ov.autoSslDomain) ctx.log?.('warn', 'TLS needs a domain on Vultr (providerOverrides.vultr.autoSslDomain); the load balancer serves HTTP only.');
      return {
        module,
        inputs: {
          name: fitName(req.name, 48),
          region: ctx.region,
          vpc_id: n.network_id,
          service: route.service,
          port: route.port,
          health_path: route.healthPath,
          auto_ssl_domain: ov.autoSslDomain ?? '',
        },
      };
    }
    default:
      throw invalid('VULTR_CAPABILITY_NOT_IMPLEMENTED', `${req.capability} is not implemented.`);
  }
}

/** Provider block: the API key comes from VULTR_API_KEY in the runner environment. */
export function vultrRootParts(): RootParts {
  return {
    requiredProviders: { vultr: VULTR_PROVIDER },
    providers: { vultr: { rate_limit: 100, retry_limit: 5 } },
  };
}
