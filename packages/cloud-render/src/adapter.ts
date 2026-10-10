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
import { RenderApi, type Deploy, type KeyValue, type LogEntry, type Owner, type Postgres, type Service } from './api.js';
import { RENDER_CAPABILITIES } from './catalog.js';
import { configChecks, renderConfig, type RenderCredentials, type RenderTargetConfig } from './config.js';
import { ensureKeyValue, ensurePostgres, findKeyValue, findPostgres, keyValueOutputs, postgresOutputs, readRenderSecret } from './datastores.js';
import { datastoreHealth, serviceHealth, toDeployment, toLogLine } from './health.js';
import { ensureService, findService, serviceOutputs } from './services.js';

export interface RenderAdapterOptions {
  /** Resolves the target's credentialRef to the API key (or a JSON object with `apiKey`). */
  resolveSecret: SecretResolver;
  /** HTTP client, injectable for tests. */
  fetch?: typeof fetch;
}

type Family = 'service' | 'postgres' | 'key-value';

function familyOf(capability: string): Family {
  if (capability === 'render-postgres') return 'postgres';
  if (capability === 'render-key-value') return 'key-value';
  if (['render-static-site', 'render-web-service', 'render-private-service'].includes(capability)) return 'service';
  throw new ProviderError('RENDER_CAPABILITY_UNKNOWN', `Render does not implement ${capability}.`, 'VALIDATION_ERROR', 'render');
}

const BASE_PATH: Record<Family, string> = { service: '/services', postgres: '/postgres', 'key-value': '/key-value' };

const REDEPLOY: ResourceActionDescriptor = {
  name: 'redeploy',
  description: 'Starts a new deploy of the current settings.',
  params: [
    { name: 'clearCache', type: 'boolean', description: 'Clear the build cache first.' },
    { name: 'commitId', type: 'string', description: 'Deploy this commit instead of the branch head.' },
  ],
};
const ROLLBACK: ResourceActionDescriptor = {
  name: 'rollback',
  description: 'Redeploys an earlier deploy of this service.',
  params: [{ name: 'deployId', type: 'string', required: true, description: 'Deploy id to roll back to, for example dep-d1abc.' }],
};
const SUSPEND: ResourceActionDescriptor = { name: 'suspend', description: 'Stops the service and its billing until resumed.', params: [] };
const RESUME: ResourceActionDescriptor = { name: 'resume', description: 'Starts a suspended service again.', params: [] };

const ACTIONS: Record<string, ResourceActionDescriptor[]> = {
  'render-static-site': [REDEPLOY, ROLLBACK, SUSPEND, RESUME],
  'render-web-service': [
    { ...REDEPLOY, params: [...REDEPLOY.params, { name: 'imageUrl', type: 'string', description: 'Deploy this image (same registry and repository) instead of the configured tag.' }] },
    { name: 'restart', description: 'Restarts the running instances without a new deploy.', params: [] },
    ROLLBACK,
    SUSPEND,
    RESUME,
    { name: 'scale', description: 'Sets a fixed number of instances.', params: [{ name: 'numInstances', type: 'number', required: true, description: 'Instances to run (1 to 100).' }] },
  ],
  'render-postgres': [{ name: 'restart', description: 'Restarts the database server.', params: [] }],
  'render-key-value': [],
};
ACTIONS['render-private-service'] = ACTIONS['render-web-service']!;

/**
 * Render (https://render.com) through its REST API: static sites, image backed web and private
 * services, Render Postgres and Render Key Value. Resources are found by name in the target
 * workspace, so repeating an apply converges instead of duplicating.
 */
export class RenderAdapter implements CloudProviderAdapter {
  readonly provider = 'render' as const;
  readonly simulated = false;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly opts: RenderAdapterOptions) {
    this.fetchFn = opts.fetch ?? ((input, init) => fetch(input, init));
  }

  capabilities(_target: CloudTarget): CloudCapability[] {
    return RENDER_CAPABILITIES;
  }

  private async client(ctx: ProviderContext): Promise<{ api: RenderApi; cfg: RenderTargetConfig }> {
    const cfg = renderConfig(ctx.target);
    if (typeof cfg.ownerId !== 'string' || !cfg.ownerId) {
      throw new ProviderError('RENDER_CONFIG_INVALID', 'The target has no ownerId (Render workspace id).', 'VALIDATION_ERROR', 'render');
    }
    const creds = await readCredentialFields<RenderCredentials>('render', ctx, this.opts.resolveSecret, { required: ['apiKey'], singleField: 'apiKey' });
    return { api: new RenderApi(creds.apiKey, this.fetchFn, ctx.signal), cfg };
  }

  async validateTarget(ctx: ProviderContext): Promise<TargetValidationResult> {
    const checks: TargetValidationCheck[] = configChecks(ctx.target, ctx.region);
    let identity: string | undefined;
    if (checks.some((c) => c.status === 'error')) {
      checks.push({ name: 'API access', status: 'skipped', message: 'Fix the configuration first.' });
    } else {
      try {
        const { api, cfg } = await this.client(ctx);
        const owner = await api.call<Owner>('GET', `/owners/${cfg.ownerId}`, { allow404: true });
        if (owner) {
          identity = owner.name;
          checks.push({ name: 'API access', status: 'ok', message: `The API key can manage workspace ${owner.name}.` });
        } else {
          checks.push({ name: 'API access', status: 'error', message: `Workspace ${cfg.ownerId} does not exist or the API key's user is not a member.` });
        }
      } catch (err) {
        checks.push({ name: 'API access', status: 'error', message: accessMessage(err) });
      }
    }
    return { ok: checks.every((c) => c.status === 'ok' || c.status === 'skipped'), checks, validatedAt: now(), ...(identity ? { identity } : {}) };
  }

  async ensureResource(ctx: ProviderContext, req: ResourceRequest): Promise<ResourceResult> {
    const { api, cfg } = await this.client(ctx);
    switch (familyOf(req.capability)) {
      case 'service':
        return ensureService(ctx, api, cfg, req);
      case 'postgres':
        return ensurePostgres(ctx, api, cfg.ownerId, req);
      case 'key-value':
        return ensureKeyValue(ctx, api, cfg.ownerId, req);
    }
  }

  /** Provider id from the identifier, its recorded outputs, or a lookup by name. */
  private async resolveId(api: RenderApi, cfg: RenderTargetConfig, res: ResourceIdentifier, family: Family): Promise<string | undefined> {
    const recorded = res.providerResourceId ?? res.outputs?.service_id ?? res.outputs?.postgres_id ?? res.outputs?.key_value_id;
    if (recorded) return String(recorded);
    const found = family === 'service' ? await findService(api, cfg.ownerId, res.name) : family === 'postgres' ? await findPostgres(api, cfg.ownerId, res.name) : await findKeyValue(api, cfg.ownerId, res.name);
    return found?.id;
  }

  async deleteResource(ctx: ProviderContext, res: ResourceIdentifier): Promise<void> {
    const { api, cfg } = await this.client(ctx);
    const family = familyOf(res.capability);
    const id = await this.resolveId(api, cfg, res, family);
    if (!id) return;
    await api.call('DELETE', `${BASE_PATH[family]}/${id}`, { allow404: true });
    ctx.log?.('info', `Deleted Render resource ${id}.`);
  }

  async getResource(ctx: ProviderContext, res: ResourceIdentifier): Promise<ResourceState> {
    const { api, cfg } = await this.client(ctx);
    const family = familyOf(res.capability);
    const id = await this.resolveId(api, cfg, res, family);
    if (!id) return { exists: false, outputs: {} };
    if (family === 'service') {
      const svc = await api.call<Service>('GET', `/services/${id}`, { allow404: true });
      return svc ? { exists: true, providerResourceId: id, outputs: await serviceOutputs(api, svc) } : { exists: false, outputs: {} };
    }
    if (family === 'postgres') {
      const pg = await api.call<Postgres>('GET', `/postgres/${id}`, { allow404: true });
      return pg ? { exists: true, providerResourceId: id, outputs: await postgresOutputs(api, pg, cfg.ownerId) } : { exists: false, outputs: {} };
    }
    const kv = await api.call<KeyValue>('GET', `/key-value/${id}`, { allow404: true });
    return kv ? { exists: true, providerResourceId: id, outputs: await keyValueOutputs(api, kv, cfg.ownerId) } : { exists: false, outputs: {} };
  }

  async probeExists(ctx: ProviderContext, res: ResourceIdentifier): Promise<boolean | undefined> {
    if (!res.providerResourceId) return undefined;
    try {
      const { api } = await this.client(ctx);
      const found = await api.call('GET', `${BASE_PATH[familyOf(res.capability)]}/${res.providerResourceId}`, { allow404: true });
      return found !== null;
    } catch {
      return undefined;
    }
  }

  async checkHealth(ctx: ProviderContext, res: ResourceIdentifier): Promise<HealthResult> {
    const started = Date.now();
    try {
      const { api, cfg } = await this.client(ctx);
      const family = familyOf(res.capability);
      const id = await this.resolveId(api, cfg, res, family);
      if (!id) return { state: 'UNHEALTHY', message: 'Not found on Render', checkedAt: now() };
      if (family === 'service') {
        const svc = await api.call<Service>('GET', `/services/${id}`, { allow404: true });
        if (!svc) return { state: 'UNHEALTHY', message: `Service ${id} not found`, checkedAt: now() };
        return await serviceHealth(api, svc, { fetch: this.fetchFn, ...(ctx.signal ? { signal: ctx.signal } : {}) });
      }
      const store = await api.call<Postgres | KeyValue>('GET', `${BASE_PATH[family]}/${id}`, { allow404: true });
      if (!store) return { state: 'UNHEALTHY', message: `${id} not found`, checkedAt: now() };
      return datastoreHealth(family === 'postgres' ? 'Postgres' : 'Key Value', store.status, started);
    } catch (err) {
      return { state: 'UNHEALTHY', message: err instanceof ProviderError ? err.message : safeMessage(err), checkedAt: now() };
    }
  }

  async getLogs(ctx: ProviderContext, res: ResourceIdentifier, limit: number): Promise<LogLine[]> {
    const { api, cfg } = await this.client(ctx);
    const id = await this.resolveId(api, cfg, res, familyOf(res.capability));
    if (!id) return [];
    const page = await api.call<{ logs?: LogEntry[] }>('GET', '/logs', {
      query: { ownerId: cfg.ownerId, resource: [id], direction: 'backward', limit: Math.min(100, Math.max(1, limit)) },
    });
    // Fetched newest first; returned oldest first like a log viewer.
    return (page?.logs ?? []).map(toLogLine).reverse();
  }

  async listDeployments(ctx: ProviderContext, res: ResourceIdentifier, limit: number): Promise<ProviderDeployment[]> {
    if (familyOf(res.capability) !== 'service') return [];
    const { api, cfg } = await this.client(ctx);
    const id = await this.resolveId(api, cfg, res, 'service');
    if (!id) return [];
    const rows = (await api.call<{ deploy: Deploy }[]>('GET', `/services/${id}/deploys`, { query: { limit: Math.min(100, Math.max(1, limit)) } })) ?? [];
    return rows.map((r) => toDeployment(r.deploy));
  }

  async readSecret(ctx: ProviderContext, ref: string): Promise<Record<string, string>> {
    const { api } = await this.client(ctx);
    return readRenderSecret(api, ref);
  }

  actions(capability: string): ResourceActionDescriptor[] {
    return ACTIONS[capability] ?? [];
  }

  async runAction(ctx: ProviderContext, res: ResourceIdentifier, request: ResourceActionRequest): Promise<ResourceActionResult> {
    const descriptor = this.actions(res.capability).find((a) => a.name === request.action);
    if (!descriptor) {
      throw new ProviderError('RENDER_ACTION_UNKNOWN', `${res.capability} has no action ${request.action}.`, 'VALIDATION_ERROR', 'render');
    }
    checkParams(descriptor, request.params);
    const { api, cfg } = await this.client(ctx);
    const family = familyOf(res.capability);
    const id = await this.resolveId(api, cfg, res, family);
    if (!id) throw new ProviderError('RENDER_RESOURCE_NOT_FOUND', `${res.name} does not exist on Render.`, 'VALIDATION_ERROR', 'render');
    const p = request.params;

    if (family === 'postgres') {
      await api.call('POST', `/postgres/${id}/restart`);
      return { status: 'started', message: `Restart of Postgres ${id} requested.` };
    }
    switch (request.action) {
      case 'redeploy': {
        const body = {
          clearCache: p.clearCache === true ? 'clear' : 'do_not_clear',
          ...(p.commitId ? { commitId: String(p.commitId) } : {}),
          ...(p.imageUrl ? { imageUrl: String(p.imageUrl) } : {}),
        };
        const deploy = await api.call<Deploy>('POST', `/services/${id}/deploys`, { body });
        return deploy?.id
          ? { reference: deploy.id, status: 'started', message: `Deploy ${deploy.id} started.` }
          : { status: 'started', message: 'Deploy queued behind the one in progress.' };
      }
      case 'rollback': {
        const deploy = await api.call<Deploy>('POST', `/services/${id}/rollback`, { body: { deployId: String(p.deployId) } });
        return { ...(deploy?.id ? { reference: deploy.id } : {}), status: 'started', message: `Rollback to ${String(p.deployId)} started.` };
      }
      case 'restart':
        await api.call('POST', `/services/${id}/restart`);
        return { status: 'started', message: `Restart of ${id} requested.` };
      case 'suspend':
      case 'resume':
        await api.call('POST', `/services/${id}/${request.action}`);
        return { status: 'started', message: `${request.action === 'suspend' ? 'Suspend' : 'Resume'} of ${id} requested.` };
      case 'scale': {
        await api.call('POST', `/services/${id}/scale`, { body: { numInstances: Number(p.numInstances) } });
        return { status: 'started', message: `Scaling ${id} to ${Number(p.numInstances)} instance(s).` };
      }
      default:
        throw new ProviderError('RENDER_ACTION_UNKNOWN', `${res.capability} has no action ${request.action}.`, 'VALIDATION_ERROR', 'render');
    }
  }
}

/** Rejects missing, unknown or mistyped parameters before calling Render. */
function checkParams(descriptor: ResourceActionDescriptor, params: ResourceActionRequest['params']): void {
  const fail = (message: string) => {
    throw new ProviderError('RENDER_ACTION_PARAMS', message, 'VALIDATION_ERROR', 'render');
  };
  for (const name of Object.keys(params)) {
    if (!descriptor.params.some((d) => d.name === name)) fail(`${descriptor.name} does not take a ${name} parameter.`);
  }
  for (const d of descriptor.params) {
    const v = params[d.name];
    if (v === undefined || v === '') {
      if (d.required) fail(`${descriptor.name} needs ${d.name}.`);
      continue;
    }
    if (typeof v !== d.type) fail(`${d.name} must be a ${d.type}.`);
  }
  if (descriptor.name === 'scale') {
    const n = Number(params.numInstances);
    if (!Number.isInteger(n) || n < 1 || n > 100) fail('numInstances must be a whole number from 1 to 100.');
  }
}

function accessMessage(err: unknown): string {
  if (err instanceof ProviderError) {
    if (err.failureClass === 'AUTHENTICATION_ERROR') {
      return err.code.includes('_CREDENTIALS_') ? err.message : 'Render rejected the API key. Create a new key under Account settings, API keys.';
    }
    if (err.failureClass === 'AUTHORIZATION_ERROR') return 'The API key cannot read this workspace.';
    return err.message;
  }
  return safeMessage(err);
}
