import { ProviderError, type ProviderContext, type ResourceOutputs, type ResourceRequest, type ResourceResult } from '@orkstage/cloud-core';
import type { Autoscaling, CustomDomain, EnvVar, RenderApi, Service, ServiceType } from './api.js';
import type { RenderTargetConfig } from './config.js';
import { dependencyEnv } from './env.js';
import { planScales, samePlan, servicePlan } from './plans.js';

interface FrontendSpec {
  source: { repository: string; branch?: string; rootDirectory?: string; gitProvider?: 'github' | 'gitlab' | 'bitbucket' };
  buildCommand?: string;
  installCommand?: string;
  outputDirectory?: string;
  nodeVersion?: string;
  environment?: Record<string, string>;
  domains?: string[];
  previewDeployments?: boolean;
}

interface ContainerSpec {
  image: string;
  replicas?: number;
  cpu?: number;
  memoryMiB?: number;
  port?: number;
  public?: boolean;
  healthCheckPath?: string;
  autoscaling?: { minReplicas: number; maxReplicas: number; targetCpuPercent: number };
}

const GIT_HOSTS = { github: 'github.com', gitlab: 'gitlab.com', bitbucket: 'bitbucket.org' } as const;

/** Render service type for a capability: container services that are not public become private services. */
export function serviceTypeFor(capability: string, spec: Record<string, unknown>): ServiceType {
  if (capability === 'render-static-site') return 'static_site';
  if (capability === 'render-private-service' || spec.public !== true) return 'private_service';
  return 'web_service';
}

export const repoUrl = (s: FrontendSpec['source']) => `https://${GIT_HOSTS[s.gitProvider ?? 'github']}/${s.repository}`;
const normRepo = (r?: string) => (r ?? '').toLowerCase().replace(/\.git$/, '').replace(/\/+$/, '');
/** Render may report Docker Hub images with their full registry path. */
const normImage = (i?: string) => (i ?? '').replace(/^docker\.io\//, '').replace(/^library\//, '');

export async function findService(api: RenderApi, ownerId: string, name: string): Promise<Service | undefined> {
  const rows = await api.list<Service>('/services', 'service', { name: [name], ownerId: [ownerId], includePreviews: false });
  return rows.find((s) => s.name === name);
}

async function listDomains(api: RenderApi, id: string): Promise<CustomDomain[]> {
  return api.list<CustomDomain>(`/services/${id}/custom-domains`, 'customDomain');
}

async function listEnv(api: RenderApi, id: string): Promise<Record<string, string>> {
  const rows = await api.list<EnvVar>(`/services/${id}/env-vars`, 'envVar');
  return Object.fromEntries(rows.map((e) => [e.key, e.value]));
}

const sameEnv = (a: Record<string, string>, b: Record<string, string>) => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => b[k] === a[k]);
};

const toEnvVars = (env: Record<string, string>): EnvVar[] => Object.entries(env).map(([key, value]) => ({ key, value }));

/** Public address: a verified custom domain when there is one, otherwise the onrender.com URL. */
function publicUrl(svc: Service, domains: CustomDomain[]): string | undefined {
  const custom = domains.find((d) => !d.redirectForName && d.verificationStatus === 'verified');
  return custom ? `https://${custom.name}` : svc.serviceDetails.url;
}

/**
 * Outputs recorded for a Render service. Only non secret values: the private service port is read
 * from its PORT variable when the caller does not pass it.
 */
export async function serviceOutputs(api: RenderApi, svc: Service, port?: string): Promise<ResourceOutputs> {
  const base: ResourceOutputs = { service_id: svc.id, render_type: svc.type, dashboard_url: svc.dashboardUrl, owner_id: svc.ownerId };
  if (svc.type === 'static_site') {
    const url = publicUrl(svc, await listDomains(api, svc.id));
    return { kind: 'web.frontend', ...base, ...(url ? { url } : {}) };
  }
  const common: ResourceOutputs = { kind: 'compute.container-service', ...base, image: svc.imagePath ?? '', ...(svc.serviceDetails.region ? { region: svc.serviceDetails.region } : {}) };
  if (svc.type === 'web_service') {
    const url = publicUrl(svc, await listDomains(api, svc.id));
    return { ...common, ...(url ? { url } : {}) };
  }
  const p = port ?? (await listEnv(api, svc.id)).PORT ?? '10000';
  return { ...common, host: svc.slug, port: Number(p) };
}

interface Desired {
  /** Top level create fields (repo, image). */
  top: Record<string, unknown>;
  /** `serviceDetails` for create. */
  details: Record<string, unknown>;
  /** Variables set on the service by the spec itself (they win over dependency variables). */
  env: Record<string, string>;
  /** PATCH body for the differences with an existing service, or null when it matches. */
  diff(existing: Service): Record<string, unknown> | null;
}

function staticDesired(spec: FrontendSpec): Desired {
  const buildCommand = [spec.installCommand, spec.buildCommand].filter((c) => c && c.trim()).join(' && ');
  const repo = repoUrl(spec.source);
  const branch = spec.source.branch ?? 'main';
  const rootDir = spec.source.rootDirectory ?? '';
  const generation = spec.previewDeployments === false ? 'off' : 'automatic';
  const details: Record<string, unknown> = {
    ...(buildCommand ? { buildCommand } : {}),
    ...(spec.outputDirectory ? { publishPath: spec.outputDirectory } : {}),
    previews: { generation },
  };
  return {
    top: { repo, branch, rootDir, autoDeploy: 'yes' },
    details,
    env: { ...(spec.nodeVersion ? { NODE_VERSION: spec.nodeVersion } : {}), ...(spec.environment ?? {}) },
    diff(existing) {
      const d = existing.serviceDetails;
      const currentGeneration = d.previews?.generation ?? (d.pullRequestPreviewsEnabled === 'yes' ? 'automatic' : 'off');
      const changed =
        normRepo(existing.repo) !== normRepo(repo) ||
        existing.branch !== branch ||
        (existing.rootDir ?? '') !== rootDir ||
        (buildCommand !== '' && d.buildCommand !== buildCommand) ||
        (spec.outputDirectory !== undefined && d.publishPath !== spec.outputDirectory) ||
        currentGeneration !== generation;
      return changed ? { repo, branch, rootDir, serviceDetails: details } : null;
    },
  };
}

function imageDesired(ctx: ProviderContext, cfg: RenderTargetConfig, spec: ContainerSpec, type: ServiceType): Desired & { plan: string } {
  const plan = servicePlan(spec.cpu ?? 0.25, spec.memoryMiB ?? 512);
  const image = { ownerId: cfg.ownerId, imagePath: spec.image, ...(cfg.registryCredentialId ? { registryCredentialId: cfg.registryCredentialId } : {}) };
  const healthCheckPath = type === 'web_service' ? (spec.healthCheckPath ?? '') : undefined;
  return {
    plan,
    top: { image },
    details: {
      runtime: 'image',
      plan,
      region: ctx.region,
      numInstances: Math.max(1, spec.replicas ?? 1),
      ...(healthCheckPath ? { healthCheckPath } : {}),
    },
    // Render routes traffic to the port named by PORT.
    env: spec.port ? { PORT: String(spec.port) } : {},
    diff(existing) {
      const d = existing.serviceDetails;
      if (d.region && d.region !== ctx.region) ctx.log?.('warn', `${existing.name} runs in ${d.region}; Render cannot move a service to ${ctx.region}.`);
      const patch: Record<string, unknown> = {};
      const details: Record<string, unknown> = {};
      if (normImage(existing.imagePath) !== normImage(spec.image)) patch.image = image;
      if (!samePlan(d.plan, plan)) details.plan = plan;
      if (healthCheckPath !== undefined && (d.healthCheckPath ?? '') !== healthCheckPath) details.healthCheckPath = healthCheckPath;
      if (Object.keys(details).length) patch.serviceDetails = details;
      return Object.keys(patch).length ? patch : null;
    },
  };
}

function desiredAutoscaling(spec: ContainerSpec, plan: string): Autoscaling | undefined {
  const a = spec.autoscaling;
  if (!a || !planScales(plan)) return undefined;
  const min = Math.max(1, a.minReplicas);
  return {
    enabled: true,
    min,
    max: Math.max(min, a.maxReplicas),
    criteria: { cpu: { enabled: true, percentage: a.targetCpuPercent }, memory: { enabled: false, percentage: 80 } },
  };
}

const sameAutoscaling = (a: Autoscaling | undefined, b: Autoscaling) =>
  Boolean(a?.enabled) && a!.min === b.min && a!.max === b.max && Boolean(a!.criteria?.cpu?.enabled) && a!.criteria.cpu.percentage === b.criteria.cpu.percentage && !a!.criteria?.memory?.enabled;

/** Converges instance count or autoscaling. Returns true when something changed. */
async function convergeScaling(ctx: ProviderContext, api: RenderApi, svc: Service, spec: ContainerSpec, plan: string): Promise<boolean> {
  const d = svc.serviceDetails;
  const wanted = desiredAutoscaling(spec, plan);
  if (wanted) {
    if (sameAutoscaling(d.autoscaling, wanted)) return false;
    try {
      await api.call('PUT', `/services/${svc.id}/autoscaling`, { body: wanted });
      return true;
    } catch (err) {
      // Autoscaling needs a Professional workspace; fall back to a fixed instance count.
      if (!(err instanceof ProviderError) || (err.details.status as number) >= 500) throw err;
      ctx.log?.('warn', `Autoscaling not accepted for ${svc.name} (${err.message}); using ${spec.replicas ?? 1} fixed instance(s).`);
    }
  } else if (d.autoscaling?.enabled) {
    await api.call('DELETE', `/services/${svc.id}/autoscaling`);
  }
  const replicas = spec.replicas ?? 1;
  if (replicas < 1) ctx.log?.('warn', 'Render services run at least one instance; use the suspend action to stop one.');
  const count = Math.max(1, replicas);
  if (d.numInstances === count && !d.autoscaling?.enabled) return false;
  await api.call('POST', `/services/${svc.id}/scale`, { body: { numInstances: count } });
  return true;
}

/** Adds the custom domains the spec lists. Domains added outside the platform are left alone. */
async function convergeDomains(ctx: ProviderContext, api: RenderApi, svc: Service, domains: string[]): Promise<boolean> {
  if (!domains.length) return false;
  const existing = new Set((await listDomains(api, svc.id)).map((d) => d.name));
  const missing = domains.filter((d) => !existing.has(d));
  for (const name of missing) await api.call('POST', `/services/${svc.id}/custom-domains`, { body: { name } });
  if (missing.length) ctx.log?.('info', `Added custom domain(s) ${missing.join(', ')}: point their DNS at Render to verify them.`);
  return missing.length > 0;
}

/**
 * Creates or converges a static site, web service or private service by name: PATCH for
 * settings, PUT for environment variables, then one deploy so the changes take effect.
 */
export async function ensureService(ctx: ProviderContext, api: RenderApi, cfg: RenderTargetConfig, req: ResourceRequest): Promise<ResourceResult> {
  const type = serviceTypeFor(req.capability, req.spec);
  const isStatic = type === 'static_site';
  const desired = isStatic ? staticDesired(req.spec as unknown as FrontendSpec) : imageDesired(ctx, cfg, req.spec as unknown as ContainerSpec, type);
  const env = { ...(await dependencyEnv(ctx, api, cfg.ownerId, req, !isStatic)), ...desired.env };
  const secretValues = Object.values(env);

  let svc = await findService(api, cfg.ownerId, req.name);
  let changed = false;
  if (!svc) {
    const body = { type, name: req.name, ownerId: cfg.ownerId, ...desired.top, envVars: toEnvVars(env), serviceDetails: desired.details };
    const created = await api.call<Service & { service?: Service; deployId?: string }>('POST', '/services', { body, scrub: secretValues });
    svc = created?.service ?? (created as Service | null) ?? undefined;
    if (!svc?.id) throw new ProviderError('RENDER_EMPTY_RESPONSE', 'Render returned no service after create.', 'UNKNOWN', 'render');
    ctx.log?.('info', `Created Render ${type} ${svc.id} with ${Object.keys(env).length} environment variable(s).`);
    changed = true;
  } else {
    if (svc.type !== type) {
      throw new ProviderError('RENDER_SERVICE_TYPE_CHANGE', `${req.name} exists as a ${svc.type}; Render cannot turn it into a ${type}. Delete it or rename the resource.`, 'RESOURCE_CONFLICT', 'render');
    }
    let redeploy = false;
    const patch = desired.diff(svc);
    if (patch) {
      svc = { ...svc, ...((await api.call<Service>('PATCH', `/services/${svc.id}`, { body: patch })) ?? {}) };
      ctx.log?.('info', `Updated Render service ${svc.id}: ${Object.keys(patch).join(', ')}.`);
      redeploy = true;
    }
    if (!sameEnv(await listEnv(api, svc.id), env)) {
      await api.call('PUT', `/services/${svc.id}/env-vars`, { body: toEnvVars(env), scrub: secretValues });
      ctx.log?.('info', `Updated environment of ${svc.id} (${Object.keys(env).length} variable(s)).`);
      redeploy = true;
    }
    if (redeploy) {
      const deploy = await api.call<{ id?: string }>('POST', `/services/${svc.id}/deploys`, { body: {} });
      ctx.log?.('info', `Started deploy${deploy?.id ? ` ${deploy.id}` : ''} for ${svc.id}.`);
      changed = true;
    }
  }

  if (!isStatic) {
    const spec = req.spec as unknown as ContainerSpec;
    const plan = (desired as Desired & { plan: string }).plan;
    if (await convergeScaling(ctx, api, svc, spec, plan)) changed = true;
  } else if (await convergeDomains(ctx, api, svc, (req.spec as unknown as FrontendSpec).domains ?? [])) {
    changed = true;
  }

  return { providerResourceId: svc.id, outputs: await serviceOutputs(api, svc, env.PORT ?? '10000'), unchanged: !changed };
}
