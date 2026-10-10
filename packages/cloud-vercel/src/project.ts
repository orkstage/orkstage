import { dependencyEnvironment, ProviderError, secretEnvironment, type ProviderContext, type ResourceOutputs, type ResourceRequest } from '@orkstage/cloud-core';
import { createHmac } from 'node:crypto';
import { apiStatus, seg, type EnvVar, type Project, type ProjectLink, type VercelApi } from './api.js';

/** The `web.frontend` spec fields this adapter reads (template defaults already applied). */
export interface FrontendSpec {
  repository: string;
  branch: string;
  rootDirectory?: string;
  gitProvider: 'github' | 'gitlab' | 'bitbucket';
  framework?: string;
  buildCommand?: string;
  installCommand?: string;
  outputDirectory?: string;
  nodeVersion?: string;
  environment: Record<string, string>;
  domains: string[];
  previewDeployments: boolean;
  healthCheckPath: string;
}

const str = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : undefined);

export function frontendSpec(req: ResourceRequest): FrontendSpec {
  const s = req.spec;
  const source = (s.source ?? {}) as Record<string, unknown>;
  const repository = str(source.repository);
  if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    throw new ProviderError('VERCEL_INVALID_SPEC', `${req.resourceId}: source.repository must be owner/name.`, 'VALIDATION_ERROR', 'vercel');
  }
  const gitProvider = str(source.gitProvider) ?? 'github';
  if (!['github', 'gitlab', 'bitbucket'].includes(gitProvider)) {
    throw new ProviderError('VERCEL_INVALID_SPEC', `${req.resourceId}: gitProvider must be github, gitlab or bitbucket.`, 'VALIDATION_ERROR', 'vercel');
  }
  const environment = Object.fromEntries(
    Object.entries((s.environment ?? {}) as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string'),
  );
  return {
    repository,
    branch: str(source.branch) ?? 'main',
    rootDirectory: str(source.rootDirectory),
    gitProvider: gitProvider as FrontendSpec['gitProvider'],
    framework: str(s.framework),
    buildCommand: str(s.buildCommand),
    installCommand: str(s.installCommand),
    outputDirectory: str(s.outputDirectory),
    nodeVersion: str(s.nodeVersion),
    environment,
    domains: Array.isArray(s.domains) ? s.domains.filter((d): d is string => typeof d === 'string') : [],
    previewDeployments: s.previewDeployments !== false,
    healthCheckPath: str(s.healthCheckPath) ?? '/',
  };
}

/** `20` and `20.x` both become the `20.x` the API expects. */
export const nodeVersion = (v: string) => (v.endsWith('.x') ? v : `${v}.x`);

export function createBody(name: string, spec: FrontendSpec, region: string): Record<string, unknown> {
  return {
    name,
    framework: spec.framework ?? null,
    gitRepository: { type: spec.gitProvider, repo: spec.repository },
    buildCommand: spec.buildCommand ?? null,
    installCommand: spec.installCommand ?? null,
    outputDirectory: spec.outputDirectory ?? null,
    rootDirectory: spec.rootDirectory ?? null,
    serverlessFunctionRegion: region,
    resourceConfig: { functionDefaultRegions: [region] },
    previewDeploymentsDisabled: !spec.previewDeployments,
  };
}

/**
 * Settings that differ between the project and the spec. A framework left out of the template
 * is not managed (Vercel detects it). `previewDeploymentsDisabled` is not returned by the API,
 * so it rides along with any other change instead of forcing one.
 */
export function projectPatch(project: Project, spec: FrontendSpec, region: string): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (spec.framework && spec.framework !== project.framework) patch.framework = spec.framework;
  for (const k of ['buildCommand', 'installCommand', 'outputDirectory', 'rootDirectory'] as const) {
    const want = spec[k] ?? null;
    if (want !== (project[k] ?? null)) patch[k] = want;
  }
  if (spec.nodeVersion && nodeVersion(spec.nodeVersion) !== project.nodeVersion) patch.nodeVersion = nodeVersion(spec.nodeVersion);
  const regions = project.resourceConfig?.functionDefaultRegions ?? [];
  if (regions.length !== 1 || regions[0] !== region) {
    patch.serverlessFunctionRegion = region;
    patch.resourceConfig = { functionDefaultRegions: [region] };
  }
  if (Object.keys(patch).length > 0) patch.previewDeploymentsDisabled = !spec.previewDeployments;
  return patch;
}

/** `owner/name` of the repository a project is connected to, when it is connected. */
export function linkedRepository(link: ProjectLink | undefined): string | undefined {
  if (!link) return undefined;
  if (link.type === 'gitlab') return link.projectNamespace && link.projectName ? `${link.projectNamespace}/${link.projectName}` : undefined;
  if (link.type === 'bitbucket') return link.owner && link.slug ? `${link.owner}/${link.slug}` : undefined;
  return link.org && link.repo ? `${link.org}/${link.repo}` : undefined;
}

export function assertSameRepository(project: Project, spec: FrontendSpec): void {
  const linked = linkedRepository(project.link);
  if (linked && linked.toLowerCase() !== spec.repository.toLowerCase()) {
    throw new ProviderError(
      'VERCEL_REPOSITORY_MISMATCH',
      `Vercel project ${project.name} is connected to ${linked}, not ${spec.repository}. Disconnect it in the project Git settings or use another resource name.`,
      'RESOURCE_CONFLICT',
      'vercel',
    );
  }
}

/** Body `gitSource` for `POST /v13/deployments`, from the project's Git link or the spec. */
export function gitSource(link: ProjectLink | undefined, fallback: { repository: string; gitProvider: string } | undefined, ref: string, sha?: string): Record<string, unknown> {
  const extra = sha ? { sha } : {};
  if (link?.type === 'gitlab' && link.projectId !== undefined) return { type: 'gitlab', projectId: String(link.projectId), ref, ...extra };
  if (link?.type === 'bitbucket' && link.owner && link.slug) return { type: 'bitbucket', owner: link.owner, slug: link.slug, ref, ...extra };
  if (link?.org && link.repo) return { type: link.type === 'github-limited' ? 'github-limited' : 'github', org: link.org, repo: link.repo, ref, ...extra };
  if (fallback && fallback.gitProvider === 'github') {
    const [org, repo] = fallback.repository.split('/');
    return { type: 'github', org, repo, ref, ...extra };
  }
  throw new ProviderError('VERCEL_NOT_CONNECTED', 'The Vercel project is not connected to a Git repository, so there is nothing to deploy from.', 'VALIDATION_ERROR', 'vercel');
}

const GIT_ACCESS = /integration|install|github|gitlab|bitbucket|repository|repo_not_found|git_source|git source/i;
const GIT_APPS: Record<string, string> = {
  github: 'Install the Vercel GitHub app on that repository (https://github.com/apps/vercel) and give it access to the repository',
  gitlab: 'Connect GitLab in the Vercel account settings (Authentication) with access to that repository',
  bitbucket: 'Connect Bitbucket in the Vercel account settings (Authentication) with access to that repository',
};

/** Rewrites "repository not reachable" API errors into an actionable validation error. */
export function gitAccessError(err: unknown, spec: Pick<FrontendSpec, 'repository' | 'gitProvider'>): unknown {
  const status = apiStatus(err);
  if (status === undefined || ![400, 403, 404, 422].includes(status)) return err;
  const e = err as ProviderError;
  if (!GIT_ACCESS.test(`${String(e.details.apiCode ?? '')} ${e.message}`)) return err;
  const provider = spec.gitProvider === 'github' ? 'GitHub' : spec.gitProvider === 'gitlab' ? 'GitLab' : 'Bitbucket';
  return new ProviderError(
    'VERCEL_GIT_NOT_CONNECTED',
    `Vercel cannot read the ${provider} repository ${spec.repository}. ${GIT_APPS[spec.gitProvider]}, then deploy again.`,
    'VALIDATION_ERROR',
    'vercel',
    { status },
  );
}

const TARGETS = ['production', 'preview'];
const MANAGED = 'orkstage:';

interface DesiredVar {
  key: string;
  value: string;
  type: 'encrypted' | 'sensitive';
}

/**
 * Environment the project should carry: plain settings from the spec and the dependencies'
 * connection settings as `encrypted`, and the credentials each dependency publishes (read
 * through `ctx.dependencySecret`) as `sensitive`, which Vercel never shows again.
 */
export async function desiredEnvironment(ctx: ProviderContext, req: ResourceRequest, spec: FrontendSpec): Promise<DesiredVar[]> {
  const plain: Record<string, string> = { ...dependencyEnvironment(req.dependencyOutputs).environment, ...spec.environment };
  const secret: Record<string, string> = {};
  for (const [id, out] of Object.entries(req.dependencyOutputs)) {
    if (!out.secret_ref) continue;
    if (!ctx.dependencySecret) {
      throw new ProviderError('VERCEL_DEPENDENCY_SECRET_UNAVAILABLE', `${req.resourceId} needs the credentials of ${id}, but no secret reader is available in this process.`, 'VALIDATION_ERROR', 'vercel');
    }
    Object.assign(secret, secretEnvironment(id, await ctx.dependencySecret(id)));
  }
  for (const k of Object.keys(secret)) delete plain[k];
  return [
    ...Object.entries(plain).map(([key, value]) => ({ key, value, type: 'encrypted' as const })),
    ...Object.entries(secret).map(([key, value]) => ({ key, value, type: 'sensitive' as const })),
  ];
}

/**
 * Sensitive values cannot be read back, so each managed variable carries a keyed fingerprint in
 * its comment. The key is the access token: the fingerprint says nothing to anyone without it.
 */
export function fingerprint(token: string, v: DesiredVar): string {
  return MANAGED + createHmac('sha256', token).update(`${v.key}\n${v.type}\n${v.value}`).digest('hex').slice(0, 24);
}

const targetsOf = (e: EnvVar) => (Array.isArray(e.target) ? e.target : e.target ? [e.target] : []);
const sameTargets = (e: EnvVar) => {
  const t = targetsOf(e);
  return t.length === TARGETS.length && TARGETS.every((x) => t.includes(x));
};

/** Converges the project's environment variables. Returns true when anything was written or removed. */
export async function syncEnvironment(api: VercelApi, projectId: string, token: string, desired: DesiredVar[]): Promise<boolean> {
  const listed = await api.get<{ envs?: EnvVar[] }>(`/v10/projects/${seg(projectId)}/env`);
  const existing = (listed?.envs ?? []).filter((e) => !e.gitBranch);
  const writes: Record<string, unknown>[] = [];
  const removals: EnvVar[] = [];
  for (const want of desired) {
    const comment = fingerprint(token, want);
    const same = existing.filter((e) => e.key === want.key);
    if (same.length === 1 && same[0]!.comment === comment && same[0]!.type === want.type && sameTargets(same[0]!)) continue;
    // Upsert cannot change a variable's type or merge split targets, so replace those.
    removals.push(...same.filter((e) => e.type !== want.type || !sameTargets(e)));
    api.hide(want.value);
    writes.push({ key: want.key, value: want.value, type: want.type, target: TARGETS, comment });
  }
  const keys = new Set(desired.map((d) => d.key));
  removals.push(...existing.filter((e) => !keys.has(e.key) && e.comment?.startsWith(MANAGED)));
  for (const e of removals) await api.delete(`/v9/projects/${seg(projectId)}/env/${seg(e.id)}`, { allow404: true });
  if (writes.length > 0) {
    const res = await api.post<{ failed?: { error?: { code?: string; key?: string; message?: string } }[] }>(`/v10/projects/${seg(projectId)}/env`, writes, { query: { upsert: 'true' } });
    const failed = res?.failed ?? [];
    if (failed.length > 0) {
      const keysFailed = failed.map((f) => f.error?.key ?? f.error?.code ?? 'unknown').join(', ');
      throw new ProviderError('VERCEL_ENV_FAILED', `Vercel rejected environment variables: ${keysFailed}.`, 'VALIDATION_ERROR', 'vercel');
    }
  }
  return writes.length > 0 || removals.length > 0;
}

/** Attaches the spec's domains that the project does not have yet. Returns how many were added. */
export async function syncDomains(ctx: ProviderContext, api: VercelApi, projectId: string, domains: string[]): Promise<number> {
  if (domains.length === 0) return 0;
  const listed = await api.get<{ domains?: { name: string }[] }>(`/v9/projects/${seg(projectId)}/domains`, { query: { limit: 100 } });
  const have = new Set((listed?.domains ?? []).map((d) => d.name.toLowerCase()));
  let added = 0;
  for (const name of domains) {
    if (have.has(name.toLowerCase())) continue;
    const res = await api.post<{ verified?: boolean }>(`/v10/projects/${seg(projectId)}/domains`, { name });
    added++;
    ctx.log?.('info', res?.verified === false ? `Domain ${name} added; it needs DNS verification before it serves traffic.` : `Domain ${name} added.`);
  }
  return added;
}

/** Public production URL: the first custom domain, else the project's vercel.app alias. */
export function productionUrl(project: Project, domains: string[]): string {
  if (domains[0]) return `https://${domains[0]}`;
  const aliases = (project.targets?.production?.alias ?? []).filter((a) => a.endsWith('.vercel.app')).sort((a, b) => a.length - b.length);
  return `https://${aliases[0] ?? `${project.name}.vercel.app`}`;
}

export function frontendOutputs(project: Project, spec: Pick<FrontendSpec, 'domains' | 'healthCheckPath' | 'branch' | 'framework'>, scope: string | undefined): ResourceOutputs {
  return {
    kind: 'web.frontend',
    project_id: project.id,
    url: productionUrl(project, spec.domains),
    dashboard_url: scope ? `https://vercel.com/${scope}/${project.name}` : 'https://vercel.com/dashboard',
    framework: project.framework ?? spec.framework ?? 'auto',
    branch: spec.branch,
    health_check_path: spec.healthCheckPath,
  };
}
