import {
  byKind,
  dependencyEnvironment,
  envKey,
  needKind,
  ProviderError,
  type ProviderContext,
  type ResourceOutputs,
  type ResourceRequest,
} from '@orkstage/cloud-core';
import type { ModuleCall, RootParts } from '@orkstage/cloud-tofu';
import { fitName, sha256 } from '@orkstage/domain';
import { appCanJoinVpc, appRegionFor } from './config.js';

/** Provider major verified against the registry (v2.105.0, October 2026). */
export const DIGITALOCEAN_PROVIDER = { source: 'digitalocean/digitalocean', version: '~> 2.100' };

const MODULE_BY_CAPABILITY: Record<string, string> = {
  vpc: 'network',
  'app-platform': 'container-service',
  'managed-postgres': 'postgres',
  'managed-valkey': 'redis',
  spaces: 'object-storage',
};

/** Basic shared CPU plans (Standard Edition) by logical size. */
const DB_SIZE: Record<string, string> = {
  micro: 'db-s-1vcpu-1gb',
  small: 'db-s-1vcpu-2gb',
  medium: 'db-s-2vcpu-4gb',
  large: 'db-s-4vcpu-8gb',
  xlarge: 'db-s-6vcpu-16gb',
};

/** Disk range in GiB that each PostgreSQL plan accepts. */
const PG_STORAGE_GIB: Record<string, [number, number]> = {
  'db-s-1vcpu-1gb': [10, 30],
  'db-s-1vcpu-2gb': [30, 60],
  'db-s-2vcpu-4gb': [60, 120],
  'db-s-4vcpu-8gb': [140, 280],
  'db-s-6vcpu-16gb': [290, 580],
};

const CACHE_SIZE: Record<string, string> = {
  micro: 'db-s-1vcpu-1gb',
  small: 'db-s-1vcpu-2gb',
  medium: 'db-s-2vcpu-4gb',
  large: 'db-s-4vcpu-8gb',
};

/** App Platform container sizes, cheapest first within each family. */
const APP_SIZES = [
  { slug: 'apps-s-1vcpu-0.5gb', vcpu: 1, memoryMiB: 512, multiple: false, dedicated: false },
  { slug: 'apps-s-1vcpu-1gb-fixed', vcpu: 1, memoryMiB: 1024, multiple: false, dedicated: false },
  { slug: 'apps-s-1vcpu-1gb', vcpu: 1, memoryMiB: 1024, multiple: true, dedicated: false },
  { slug: 'apps-s-1vcpu-2gb', vcpu: 1, memoryMiB: 2048, multiple: true, dedicated: false },
  { slug: 'apps-s-2vcpu-4gb', vcpu: 2, memoryMiB: 4096, multiple: true, dedicated: false },
  { slug: 'apps-d-1vcpu-0.5gb', vcpu: 1, memoryMiB: 512, multiple: true, dedicated: true },
  { slug: 'apps-d-1vcpu-1gb', vcpu: 1, memoryMiB: 1024, multiple: true, dedicated: true },
  { slug: 'apps-d-1vcpu-2gb', vcpu: 1, memoryMiB: 2048, multiple: true, dedicated: true },
  { slug: 'apps-d-1vcpu-4gb', vcpu: 1, memoryMiB: 4096, multiple: true, dedicated: true },
  { slug: 'apps-d-2vcpu-4gb', vcpu: 2, memoryMiB: 4096, multiple: true, dedicated: true },
  { slug: 'apps-d-2vcpu-8gb', vcpu: 2, memoryMiB: 8192, multiple: true, dedicated: true },
  { slug: 'apps-d-4vcpu-8gb', vcpu: 4, memoryMiB: 8192, multiple: true, dedicated: true },
  { slug: 'apps-d-4vcpu-16gb', vcpu: 4, memoryMiB: 16384, multiple: true, dedicated: true },
  { slug: 'apps-d-8vcpu-32gb', vcpu: 8, memoryMiB: 32768, multiple: true, dedicated: true },
];

/** Datacenters without Spaces. */
const NO_SPACES = new Set(['nyc1', 'nyc2', 'ams2', 'sfo1']);

const notImplemented = (capability: string) =>
  new ProviderError('DIGITALOCEAN_CAPABILITY_NOT_IMPLEMENTED', `${capability} is not implemented by the DigitalOcean adapter. Choose another implementation.`, 'VALIDATION_ERROR', 'digitalocean');

const invalid = (code: string, message: string) => new ProviderError(`DIGITALOCEAN_${code}`, message, 'VALIDATION_ERROR', 'digitalocean');

type Spec = Record<string, unknown>;
type Overrides = { instanceSizeSlug?: string; size?: string };

const overridesOf = (spec: Spec): Overrides => (spec.providerOverrides as { digitalocean?: Overrides } | undefined)?.digitalocean ?? {};

/**
 * Smallest App Platform size that fits the requested vCPU and memory. Several instances need a
 * size that scales horizontally; autoscaling needs a dedicated CPU size.
 */
export function appInstanceSize(cpu: number, memoryMiB: number, opts: { multiple: boolean; autoscaling: boolean }): string {
  const fit = APP_SIZES.find((s) => s.vcpu >= cpu && s.memoryMiB >= memoryMiB && (!opts.multiple || s.multiple) && (!opts.autoscaling || s.dedicated));
  if (!fit) throw invalid('SIZE_UNAVAILABLE', `No App Platform size offers ${cpu} vCPU and ${memoryMiB} MiB; the largest is 8 vCPU and 32 GiB.`);
  return fit.slug;
}

export interface AppImage {
  registry_type: 'DOCR' | 'DOCKER_HUB' | 'GHCR';
  registry: string;
  repository: string;
  tag: string;
  digest: string;
}

/**
 * Splits an image reference into the App Platform image source. App Platform pulls from
 * DigitalOcean Container Registry, Docker Hub and GHCR only.
 */
export function parseImage(ref: string): AppImage {
  let rest = ref.trim();
  let digest = '';
  const at = rest.indexOf('@');
  if (at >= 0) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
  }
  let tag = '';
  const colon = rest.lastIndexOf(':');
  if (colon > rest.lastIndexOf('/')) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
  }
  if (!digest && !tag) tag = 'latest';
  if (digest) tag = '';
  const parts = rest.split('/').filter(Boolean);
  const first = parts[0] ?? '';
  const hasHost = parts.length > 1 && (first.includes('.') || first.includes(':') || first === 'localhost');
  const host = hasHost ? first : 'docker.io';
  const path = hasHost ? parts.slice(1) : parts;
  if (!path.length) throw invalid('IMAGE_INVALID', 'The image reference is empty.');

  if (host === 'registry.digitalocean.com') {
    if (path.length < 2) throw invalid('IMAGE_INVALID', 'A DigitalOcean Container Registry image needs registry.digitalocean.com/<registry>/<repository>.');
    return { registry_type: 'DOCR', registry: '', repository: path.slice(1).join('/'), tag, digest };
  }
  if (host === 'ghcr.io') {
    if (path.length < 2) throw invalid('IMAGE_INVALID', 'A GHCR image needs ghcr.io/<owner>/<repository>.');
    return { registry_type: 'GHCR', registry: path[0]!, repository: path.slice(1).join('/'), tag, digest };
  }
  if (host === 'docker.io' || host === 'index.docker.io' || host === 'registry-1.docker.io') {
    return path.length === 1
      ? { registry_type: 'DOCKER_HUB', registry: 'library', repository: path[0]!, tag, digest }
      : { registry_type: 'DOCKER_HUB', registry: path[0]!, repository: path.slice(1).join('/'), tag, digest };
  }
  throw invalid('IMAGE_REGISTRY_UNSUPPORTED', `App Platform cannot pull from ${host}. Push the image to DigitalOcean Container Registry, Docker Hub or GHCR.`);
}

/** DigitalOcean tags are plain names: `platform:environment` = `production` becomes `platform:environment:production`. */
export function doTags(tags: Record<string, string>): string[] {
  return Object.entries(tags).map(([k, v]) => `${k}:${v}`.replace(/[^A-Za-z0-9_:-]/g, '_').slice(0, 255));
}

const truthy = (v: unknown) => v === true || v === 'true';

/** Module and inputs for one logical resource. */
export function moduleCall(ctx: ProviderContext, req: ResourceRequest): ModuleCall {
  const module = MODULE_BY_CAPABILITY[req.capability];
  if (!module) throw notImplemented(req.capability);
  const spec = req.spec as Spec;
  const deps = req.dependencyOutputs;
  const production = req.tags['platform:environment'] === 'production';
  const network = () => needKind('digitalocean', deps, 'network', req.resourceId);

  switch (module) {
    case 'network':
      return { module, inputs: { name: fitName(req.name, 63), region: ctx.region } };

    case 'container-service':
      return { module, inputs: containerInputs(ctx, req, spec) };

    case 'postgres': {
      const n = network();
      const ha = spec.highAvailability !== undefined && spec.highAvailability !== 'none';
      let size = overridesOf(spec).size ?? DB_SIZE[String(spec.size ?? 'small')] ?? DB_SIZE.small!;
      // The 1 GiB plan cannot have a standby node.
      if (ha && size === DB_SIZE.micro) size = DB_SIZE.small!;
      return {
        module,
        inputs: {
          name: fitName(req.name, 63),
          region: ctx.region,
          engine_version: String(spec.version ?? '17'),
          size,
          node_count: ha ? 2 : 1,
          storage_size_mib: postgresStorageMiB(size, Number(spec.storageGiB ?? 0)),
          vpc_id: n.network_id,
          vpc_cidr: n.cidr,
          public_access: Boolean(spec.publicAccess),
          tags: doTags(req.tags),
        },
      };
    }

    case 'redis': {
      const n = network();
      const replicas = Math.min(2, Math.max(0, Number(spec.replicas ?? 0)));
      return {
        module,
        inputs: {
          name: fitName(req.name, 63),
          region: ctx.region,
          size: overridesOf(spec).size ?? CACHE_SIZE[String(spec.size ?? 'micro')] ?? CACHE_SIZE.micro!,
          node_count: 1 + replicas,
          vpc_id: n.network_id,
          vpc_cidr: n.cidr,
          tags: doTags(req.tags),
        },
      };
    }

    case 'object-storage': {
      if (NO_SPACES.has(ctx.region)) throw invalid('SPACES_UNAVAILABLE', `Spaces is not offered in ${ctx.region}. Place the bucket in a region with Spaces, such as nyc3.`);
      // Bucket names are global across Spaces: a short hash of the target keeps them apart.
      const suffix = sha256(ctx.target.id).slice(0, 8);
      return {
        module,
        inputs: {
          name: `${fitName(req.name, 54)}-${suffix}`,
          region: ctx.region,
          versioning: Boolean(spec.versioning),
          public_read: Boolean(spec.publicAccess),
          retention_days: spec.retentionDays ?? null,
          force_destroy: !production,
        },
      };
    }

    default:
      throw notImplemented(req.capability);
  }
}

/** Disk for a PostgreSQL plan: null keeps the plan minimum; larger requests are capped at the plan maximum. */
export function postgresStorageMiB(size: string, storageGiB: number): number | null {
  const range = PG_STORAGE_GIB[size];
  if (!range || !(storageGiB > range[0])) return null;
  const gib = Math.min(range[1], Math.ceil(storageGiB / 10) * 10);
  return gib * 1024;
}

function containerInputs(ctx: ProviderContext, req: ResourceRequest, spec: Spec): Record<string, unknown> {
  const region = appRegionFor(ctx.region);
  if (!region) throw invalid('APP_REGION_UNAVAILABLE', `App Platform does not run in ${ctx.region}.`);
  const deps = req.dependencyOutputs;
  const network = byKind(deps, 'network');
  const joinVpc = Boolean(network?.network_id) && appCanJoinVpc(ctx.region);

  const { environment, secretRefs } = dependencyEnvironment(deps);
  if (spec.port) environment.PORT = String(spec.port);
  const databaseClusters: Record<string, string> = {};
  for (const [id, out] of Object.entries(deps)) {
    const ref = String(out.secret_ref ?? '');
    if (!ref) continue;
    const key = envKey(id);
    if (ref.startsWith('do-db://') && out.cluster_name) {
      if (!joinVpc && !truthy(out.public_access)) {
        throw invalid(
          'DATABASE_UNREACHABLE',
          `${id} accepts connections only from its VPC, and App Platform can join a VPC in ${ctx.region} only from another datacenter. Use ams3, atl1, blr1, fra1, lon1, nyc1, sfo3, sgp1, syd1 or tor1, or allow public access on ${id}.`,
        );
      }
      databaseClusters[key] = String(out.cluster_name);
      // The connection string arrives as <KEY>_URL (SECRET); the reference is not needed.
      delete secretRefs[key];
    }
  }
  // References from other providers are passed as references; the app resolves them itself.
  for (const [key, ref] of Object.entries(secretRefs)) environment[`${key}_CREDENTIALS_REF`] = ref;

  const autoscaling = appAutoscaling(spec);
  const replicas = Math.max(1, Number(spec.replicas ?? 1));
  const cpu = Number(spec.cpu ?? 0.25);
  const memoryMiB = Number(spec.memoryMiB ?? 512);
  const size = overridesOf(spec).instanceSizeSlug ?? appInstanceSize(cpu, memoryMiB, { multiple: replicas > 1 || autoscaling !== null, autoscaling: autoscaling !== null });

  const ingress = byKind(deps, 'ingress');
  const routes = ingress?.routes ? (JSON.parse(String(ingress.routes)) as { service: string; pathPrefix?: string }[]) : [];
  const route = routes.find((r) => r.service === req.resourceId);

  return {
    name: fitName(req.name, 32),
    region,
    image: parseImage(String(spec.image ?? '')),
    image_ref: String(spec.image ?? ''),
    instance_size_slug: size,
    instance_count: replicas,
    autoscaling,
    port: spec.port ?? null,
    public: Boolean(spec.public) || Boolean(route),
    path_prefix: route?.pathPrefix ?? '/',
    health_check_path: String(spec.healthCheckPath ?? ''),
    environment,
    database_clusters: databaseClusters,
    vpc_id: joinVpc ? String(network!.network_id) : '',
  };
}

/** Template autoscaling to App Platform CPU autoscaling (min must stay below max). */
export function appAutoscaling(spec: Spec): { min_instance_count: number; max_instance_count: number; cpu_percent: number } | null {
  const a = spec.autoscaling as { minReplicas: number; maxReplicas: number; targetCpuPercent: number } | undefined;
  if (!a) return null;
  const min = Math.max(1, a.minReplicas);
  return { min_instance_count: min, max_instance_count: Math.max(min + 1, a.maxReplicas), cpu_percent: a.targetCpuPercent };
}

/** Built in App Platform routing: no infrastructure, only the route table services read. */
export function virtualIngress(req: ResourceRequest): ResourceOutputs | undefined {
  if (req.capability !== 'app-platform-ingress') return undefined;
  const routes = ((req.spec.routes ?? []) as { service: string; pathPrefix?: string }[]).map((r) => ({ service: r.service, pathPrefix: r.pathPrefix ?? '/' }));
  return { kind: 'ingress', mode: 'app-platform', routes: JSON.stringify(routes), tls: req.spec.tls !== false };
}

/**
 * Provider block without credentials: the token and Spaces keys come from DIGITALOCEAN_TOKEN,
 * SPACES_ACCESS_KEY_ID and SPACES_SECRET_ACCESS_KEY in the runner environment.
 */
export function rootParts(): RootParts {
  return { requiredProviders: { digitalocean: DIGITALOCEAN_PROVIDER }, providers: { digitalocean: {} } };
}
