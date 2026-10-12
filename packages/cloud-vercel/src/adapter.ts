// SPDX-License-Identifier: AGPL-3.0-only
import {
  now,
  ProviderError,
  readCredentialFields,
  safeMessage,
  type CloudCapability,
  type CloudProviderAdapter,
  type CloudTarget,
  type HealthResult,
  type LogLine,
  type ProviderContext,
  type ProviderDeployment,
  type ResourceActionDescriptor,
  type ResourceActionRequest,
  type ResourceActionResult,
  type ResourceIdentifier,
  type ResourceRequest,
  type ResourceResult,
  type ResourceState,
  type SecretResolver,
  type TargetValidationCheck,
  type TargetValidationResult,
} from '@orkstage/cloud-core';
import { apiStatus, seg, VercelApi, type Deployment, type DeploymentEvent, type Project } from './api.js';
import { VERCEL_CAPABILITIES } from './catalog.js';
import { configChecks, vercelConfig, type VercelCredentials } from './config.js';
import { frontendHealth, toLogLines, toProviderDeployment } from './health.js';
import {
  assertSameRepository,
  createBody,
  desiredEnvironment,
  frontendOutputs,
  frontendSpec,
  gitAccessError,
  gitSource,
  productionUrl,
  projectPatch,
  syncDomains,
  syncEnvironment,
} from './project.js';

export interface VercelAdapterOptions {
  /** Resolves the target's `credentialRef` to the access token (or a JSON object with `token`). */
  resolveSecret: SecretResolver;
  /** Injected for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
}

const CAPABILITY = 'vercel-project';

const ACTIONS: ResourceActionDescriptor[] = [
  {
    name: 'redeploy',
    description: 'Build and deploy a branch or commit from the connected repository.',
    params: [
      { name: 'ref', type: 'string', description: 'Branch name or full commit SHA. Defaults to the template branch.' },
      { name: 'target', type: 'string', description: 'production (default) or preview.' },
    ],
  },
  {
    name: 'promote',
    description: 'Point the production domains at an existing deployment without rebuilding it.',
    params: [{ name: 'deploymentId', type: 'string', required: true, description: 'Deployment id, dpl_...' }],
  },
  {
    name: 'rollback',
    description: 'Point production back at an earlier production deployment.',
    params: [{ name: 'deploymentId', type: 'string', description: 'Deployment id, dpl_... Defaults to the previous production deployment.' }],
  },
  {
    name: 'purge-cache',
    description: 'Mark cached CDN responses as stale so they are revalidated on the next request.',
    params: [{ name: 'tag', type: 'string', description: 'Cache tag to invalidate. Defaults to every cached response of the project.' }],
  },
];

const DEPLOYMENT_ID = /^dpl_[A-Za-z0-9]+$/;
const GIT_REF = /^[\w./-]{1,250}$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/i;

/**
 * Vercel as an application platform for `web.frontend` resources: one Vercel project per
 * resource, connected to the template's Git repository, driven through the REST API.
 */
export class VercelAdapter implements CloudProviderAdapter {
  readonly provider = 'vercel' as const;
  readonly simulated = false;
  private readonly fetchFn: typeof fetch;
  /** Team slug or username per target, for dashboard links. */
  private readonly scopes = new Map<string, string>();

  constructor(private readonly opts: VercelAdapterOptions) {
    this.fetchFn = opts.fetch ?? ((input, init) => fetch(input, init));
  }

  capabilities(_target: CloudTarget): CloudCapability[] {
    return VERCEL_CAPABILITIES;
  }

  async validateTarget(ctx: ProviderContext): Promise<TargetValidationResult> {
    const validatedAt = now();
    const checks: TargetValidationCheck[] = configChecks(ctx.target, ctx.region);
    if (checks.some((c) => c.status === 'error')) return { ok: false, checks, validatedAt };

    let client: { api: VercelApi; token: string };
    try {
      client = await this.client(ctx);
      checks.push({ name: 'Access token', status: 'ok', message: 'Token read from the credential reference.' });
    } catch (err) {
      checks.push({ name: 'Access token', status: 'error', message: (err as Error).message });
      return { ok: false, checks, validatedAt };
    }

    const { teamId } = vercelConfig(ctx.target);
    let identity: string | undefined;
    try {
      identity = await this.scope(ctx, client.api);
      checks.push({ name: teamId ? 'Team access' : 'Account access', status: 'ok', message: teamId ? `Token can act on team ${identity}.` : `Token belongs to ${identity}.` });
    } catch (err) {
      checks.push({ name: teamId ? 'Team access' : 'Account access', status: 'error', message: accessMessage(err, teamId) });
      return { ok: false, checks, validatedAt };
    }

    try {
      await client.api.get('/v10/projects', { query: { limit: 1 } });
      checks.push({ name: 'Project access', status: 'ok', message: 'Token can list and manage projects.' });
    } catch (err) {
      checks.push({ name: 'Project access', status: 'error', message: accessMessage(err, teamId) });
    }
    return { ok: checks.every((c) => c.status === 'ok' || c.status === 'skipped'), checks, validatedAt, identity };
  }

  async ensureResource(ctx: ProviderContext, req: ResourceRequest): Promise<ResourceResult> {
    if (req.capability !== CAPABILITY) {
      throw new ProviderError('VERCEL_UNSUPPORTED_CAPABILITY', `Vercel does not offer ${req.capability}.`, 'VALIDATION_ERROR', 'vercel');
    }
    const spec = frontendSpec(req);
    const env = await desiredEnvironment(ctx, req, spec);
    const { api, token } = await this.client(ctx);

    let project = await api.get<Project>(`/v9/projects/${seg(req.name)}`, { allow404: true });
    let created = false;
    if (!project) {
      project = await api.post<Project>('/v11/projects', createBody(req.name, spec, ctx.region)).catch((err) => {
        throw gitAccessError(err, spec);
      });
      created = true;
      ctx.log?.('info', `Created Vercel project ${req.name} connected to ${spec.repository}.`);
    } else {
      assertSameRepository(project, spec);
    }
    if (!project) throw new ProviderError('VERCEL_EMPTY_RESPONSE', 'Vercel returned no project after creating it.', 'UNKNOWN', 'vercel');
    let current = project;

    const patch = projectPatch(current, spec, ctx.region);
    const patched = Object.keys(patch).length > 0;
    if (patched) {
      current = (await api.patch<Project>(`/v9/projects/${seg(current.id)}`, patch)) ?? current;
      ctx.log?.('info', `Updated project settings: ${Object.keys(patch).join(', ')}.`);
    }

    const envChanged = await syncEnvironment(api, current.id, token, env);
    if (envChanged) ctx.log?.('info', `Environment variables updated (${env.length} managed).`);
    const domainsAdded = await syncDomains(ctx, api, current.id, spec.domains);

    let deployed = false;
    if (created || patched || envChanged || !current.targets?.production?.id) {
      const deployment = await api
        .post<Deployment & { id?: string }>(
          '/v13/deployments',
          { name: current.name, project: current.id, target: 'production', gitSource: gitSource(current.link, spec, spec.branch) },
          { query: { skipAutoDetectionConfirmation: 1 } },
        )
        .catch((err) => {
          throw gitAccessError(err, spec);
        });
      deployed = true;
      ctx.log?.('info', `Production deployment ${deployment?.id ?? deployment?.uid ?? 'request'} started from ${spec.branch}.`);
    }

    const scope = await this.scope(ctx, api).catch(() => undefined);
    return {
      providerResourceId: current.id,
      outputs: frontendOutputs(current, spec, scope),
      unchanged: !(created || patched || envChanged || domainsAdded > 0 || deployed),
    };
  }

  async deleteResource(ctx: ProviderContext, resource: ResourceIdentifier): Promise<void> {
    const { api } = await this.client(ctx);
    await api.delete(`/v9/projects/${seg(projectRef(resource))}`, { allow404: true });
  }

  async getResource(ctx: ProviderContext, resource: ResourceIdentifier): Promise<ResourceState> {
    const { api } = await this.client(ctx);
    const project = await api.get<Project>(`/v9/projects/${seg(projectRef(resource))}`, { allow404: true });
    if (!project) return { exists: false, outputs: {} };
    const prev = resource.outputs ?? {};
    const domains = typeof prev.url === 'string' && !prev.url.endsWith('.vercel.app') ? [new URL(prev.url).host] : [];
    const scope = await this.scope(ctx, api).catch(() => undefined);
    return {
      exists: true,
      providerResourceId: project.id,
      outputs: frontendOutputs(
        project,
        { domains, healthCheckPath: String(prev.health_check_path ?? '/'), branch: String(prev.branch ?? project.link?.productionBranch ?? 'main'), framework: undefined },
        scope,
      ),
    };
  }

  async probeExists(ctx: ProviderContext, resource: ResourceIdentifier): Promise<boolean | undefined> {
    try {
      const { api } = await this.client(ctx);
      return (await api.get<Project>(`/v9/projects/${seg(projectRef(resource))}`, { allow404: true })) !== null;
    } catch {
      return undefined;
    }
  }

  async checkHealth(ctx: ProviderContext, resource: ResourceIdentifier): Promise<HealthResult> {
    try {
      const { api } = await this.client(ctx);
      const latest = await this.latestProduction(api, projectRef(resource));
      let url = typeof resource.outputs?.url === 'string' ? resource.outputs.url : undefined;
      if (!url && latest) {
        const project = await api.get<Project>(`/v9/projects/${seg(projectRef(resource))}`, { allow404: true });
        if (project) url = productionUrl(project, []);
      }
      return await frontendHealth(latest, url, String(resource.outputs?.health_check_path ?? '/'), { fetch: this.fetchFn, signal: ctx.signal });
    } catch (err) {
      return { state: 'UNKNOWN', message: safeMessage(err), checkedAt: now() };
    }
  }

  async listDeployments(ctx: ProviderContext, resource: ResourceIdentifier, limit: number): Promise<ProviderDeployment[]> {
    const { api } = await this.client(ctx);
    const ref = projectRef(resource);
    const project = await api.get<Project>(`/v9/projects/${seg(ref)}`, { allow404: true });
    if (!project) return [];
    const res = await api.get<{ deployments?: Deployment[] }>('/v7/deployments', { query: { projectId: project.id, limit: Math.min(Math.max(limit, 1), 100) } });
    return (res?.deployments ?? []).map((d) => toProviderDeployment(d, project.targets?.production?.id ?? undefined));
  }

  async getLogs(ctx: ProviderContext, resource: ResourceIdentifier, limit: number): Promise<LogLine[]> {
    const { api } = await this.client(ctx);
    const latest = await this.latestProduction(api, projectRef(resource));
    if (!latest) return [];
    const events = await api.get<DeploymentEvent[]>(`/v3/deployments/${seg(latest.uid)}/events`, {
      query: { builds: 1, direction: 'backward', limit: Math.min(Math.max(limit, 1), 1000) },
    });
    return toLogLines(Array.isArray(events) ? events : [], latest.uid).slice(-limit);
  }

  actions(capability: string): ResourceActionDescriptor[] {
    return capability === CAPABILITY ? ACTIONS : [];
  }

  async runAction(ctx: ProviderContext, resource: ResourceIdentifier, request: ResourceActionRequest): Promise<ResourceActionResult> {
    const params = checkParams(request);
    const { api } = await this.client(ctx);
    const project = await api.get<Project>(`/v9/projects/${seg(projectRef(resource))}`, { allow404: true });
    if (!project) {
      throw new ProviderError('VERCEL_PROJECT_NOT_FOUND', `Vercel project ${resource.name} does not exist; deploy the instance first.`, 'VALIDATION_ERROR', 'vercel');
    }
    const prodUrl = typeof resource.outputs?.url === 'string' ? resource.outputs.url : productionUrl(project, []);

    switch (request.action) {
      case 'redeploy': {
        const target = params.target ?? 'production';
        const defaultRef = String(resource.outputs?.branch ?? project.link?.productionBranch ?? 'main');
        const ref = params.ref ?? defaultRef;
        const source = COMMIT_SHA.test(ref) ? gitSource(project.link, undefined, defaultRef, ref.toLowerCase()) : gitSource(project.link, undefined, ref);
        const d = await api.post<{ id: string; url?: string }>(
          '/v13/deployments',
          { name: project.name, project: project.id, ...(target === 'production' ? { target: 'production' } : {}), gitSource: source },
          { query: { skipAutoDetectionConfirmation: 1 } },
        );
        return { reference: d?.id, status: 'started', message: `${target === 'production' ? 'Production' : 'Preview'} deployment started from ${ref}.`, url: d?.url ? `https://${d.url}` : undefined };
      }
      case 'promote': {
        const id = params.deploymentId!;
        await api.post(`/v10/projects/${seg(project.id)}/promote/${seg(id)}`, {});
        return { reference: id, status: 'started', message: `Promoting ${id} to production.`, url: prodUrl };
      }
      case 'rollback': {
        const id = params.deploymentId ?? (await this.previousProduction(api, project));
        await api.post(`/v1/projects/${seg(project.id)}/rollback/${seg(id)}`, {}, { query: { description: 'Requested through OrkStage' } });
        return { reference: id, status: 'started', message: `Rolling production back to ${id}.`, url: prodUrl };
      }
      case 'purge-cache': {
        const tag = params.tag ?? '*';
        await api.post('/v1/edge-cache/invalidate-by-tags', { tags: [tag] }, { query: { projectIdOrName: project.id } });
        return { status: 'completed', message: tag === '*' ? 'Every cached response was marked stale.' : `Cached responses tagged ${tag} were marked stale.`, url: prodUrl };
      }
      default:
        throw new ProviderError('VERCEL_UNKNOWN_ACTION', `Unknown action ${request.action}.`, 'VALIDATION_ERROR', 'vercel');
    }
  }

  private async client(ctx: ProviderContext): Promise<{ api: VercelApi; token: string }> {
    const creds = await readCredentialFields<VercelCredentials>('vercel', ctx, this.opts.resolveSecret, { required: ['token'], singleField: 'token' });
    return { api: new VercelApi(creds.token, vercelConfig(ctx.target).teamId, this.fetchFn, ctx.signal), token: creds.token };
  }

  /** Team slug, or username for a personal account. Throws on API errors (validation reports them). */
  private async scope(ctx: ProviderContext, api: VercelApi): Promise<string> {
    const { teamId } = vercelConfig(ctx.target);
    const key = `${ctx.target.id}:${teamId ?? ''}`;
    const hit = this.scopes.get(key);
    if (hit) return hit;
    const value = teamId
      ? ((await api.get<{ slug?: string; id?: string }>(`/v2/teams/${seg(teamId)}`))?.slug ?? teamId)
      : ((await api.get<{ user?: { username?: string } }>('/v2/user'))?.user?.username ?? 'personal');
    this.scopes.set(key, value);
    return value;
  }

  private async latestProduction(api: VercelApi, ref: string): Promise<Deployment | undefined> {
    const res = await api.get<{ deployments?: Deployment[] }>('/v7/deployments', { query: { projectId: ref, target: 'production', limit: 1 } });
    return res?.deployments?.[0];
  }

  private async previousProduction(api: VercelApi, project: Project): Promise<string> {
    const res = await api.get<{ deployments?: Deployment[] }>('/v7/deployments', { query: { projectId: project.id, target: 'production', state: 'READY', limit: 20 } });
    const ready = (res?.deployments ?? []).sort((a, b) => b.createdAt - a.createdAt);
    const currentId = project.targets?.production?.id;
    const current = ready.find((d) => d.uid === currentId);
    const previous = current ? ready.find((d) => d.createdAt < current.createdAt) : ready[1];
    if (!previous) {
      throw new ProviderError('VERCEL_NO_ROLLBACK_TARGET', 'There is no earlier ready production deployment to roll back to.', 'VALIDATION_ERROR', 'vercel');
    }
    return previous.uid;
  }
}

const projectRef = (r: ResourceIdentifier) => r.providerResourceId ?? r.name;

interface ActionParams {
  ref?: string;
  target?: 'production' | 'preview';
  deploymentId?: string;
  tag?: string;
}

/** Rejects unknown actions, unknown or mistyped params, and malformed values before any API call. */
export function checkParams(request: ResourceActionRequest): ActionParams {
  const descriptor = ACTIONS.find((a) => a.name === request.action);
  const fail = (message: string) => new ProviderError('VERCEL_INVALID_ACTION', message, 'VALIDATION_ERROR', 'vercel');
  if (!descriptor) throw fail(`Unknown action ${request.action}. Vercel offers: ${ACTIONS.map((a) => a.name).join(', ')}.`);
  const params = request.params ?? {};
  for (const [name, value] of Object.entries(params)) {
    const spec = descriptor.params.find((p) => p.name === name);
    if (!spec) throw fail(`${request.action} does not accept the parameter ${name}.`);
    if (typeof value !== spec.type) throw fail(`${request.action}: ${name} must be a ${spec.type}.`);
  }
  for (const p of descriptor.params) {
    if (p.required && (params[p.name] === undefined || params[p.name] === '')) throw fail(`${request.action} needs ${p.name}.`);
  }
  const out = params as ActionParams;
  if (out.ref !== undefined && !GIT_REF.test(out.ref)) throw fail('ref must be a branch name or a commit SHA.');
  if (out.target !== undefined && out.target !== 'production' && out.target !== 'preview') throw fail('target must be production or preview.');
  if (out.deploymentId !== undefined && !DEPLOYMENT_ID.test(out.deploymentId)) throw fail('deploymentId must look like dpl_abc123.');
  if (out.tag !== undefined && (out.tag.length === 0 || out.tag.length > 256 || out.tag.includes(','))) throw fail('tag must be 1 to 256 characters without commas.');
  return out;
}

function accessMessage(err: unknown, teamId: string | undefined): string {
  const status = apiStatus(err);
  if (status === 401) return 'Vercel rejected the token: it is invalid, expired or revoked. Create a new access token.';
  if (status === 403) {
    return teamId
      ? `The token cannot act on team ${teamId}. Create it with that team in its scope (Account settings, Tokens).`
      : 'The token is not allowed to read the account. Create a token with full account scope.';
  }
  if (status === 404 && teamId) return `Team ${teamId} was not found for this token. Check the team id and the token scope.`;
  return safeMessage(err);
}
