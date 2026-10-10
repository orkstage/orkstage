import {
  failureClassForStatus,
  HttpError,
  ProviderError,
  readCredentialFields,
  safeMessage,
  type CloudCapability,
  type CloudTarget,
  type HealthResult,
  type LogLine,
  type ProviderContext,
  type ProviderDeployment,
  type ResourceActionDescriptor,
  type ResourceActionRequest,
  type ResourceActionResult,
  type ResourceIdentifier,
  type ResourceOutputs,
  type ResourceRequest,
  type TargetValidationCheck,
  type ValidateTargetOptions,
} from '@orkstage/cloud-core';
import {
  OpenTofuAdapter,
  S3CompatibleStateStore,
  s3BackendEnv,
  s3CompatibleBackend,
  type ModuleCall,
  type RootParts,
  type StateStore,
} from '@orkstage/cloud-tofu';
import { DIGITALOCEAN_CAPABILITIES } from './catalog.js';
import {
  configChecks,
  CREDENTIAL_FIELDS,
  digitalOceanConfig,
  SPACES_SIGNING_REGION,
  spacesEndpoint,
  type DigitalOceanCredentials,
} from './config.js';
import {
  checkDigitalOceanHealth,
  doApi,
  listAppDeployments,
  probeDigitalOceanExists,
  readAppLogs,
  readDatabaseConnection,
  type DoApi,
} from './health.js';
import { moduleCall, rootParts, virtualIngress } from './stacks.js';

/** Token scopes each service kind needs, probed with a cheap read. */
const SCOPE_PROBES: { kinds: string[]; path: string; label: string }[] = [
  { kinds: ['network'], path: '/v2/vpcs?per_page=1', label: 'vpc' },
  { kinds: ['compute.container-service'], path: '/v2/apps?per_page=1', label: 'app' },
  { kinds: ['database.postgresql', 'cache.redis'], path: '/v2/databases/options', label: 'database' },
];

const APP_ACTIONS: ResourceActionDescriptor[] = [
  {
    name: 'redeploy',
    description: 'Start a new App Platform deployment of the current spec (pulls the image again).',
    params: [{ name: 'forceBuild', type: 'boolean', description: 'Rebuild even when nothing changed. Defaults to true.' }],
  },
  { name: 'restart', description: 'Rolling restart of the service instances without a new deployment.', params: [] },
];

export const DB_REF_PREFIX = 'do-db://';

/**
 * DigitalOcean through OpenTofu: VPC, App Platform, Managed PostgreSQL, Managed Valkey and
 * Spaces, with state in a Spaces bucket of the customer. Health, logs, deployments and actions
 * use the DigitalOcean REST API with the target token.
 */
export class DigitalOceanAdapter extends OpenTofuAdapter<DigitalOceanCredentials> {
  readonly provider = 'digitalocean' as const;

  capabilities(_target: CloudTarget): CloudCapability[] {
    return DIGITALOCEAN_CAPABILITIES;
  }

  protected configChecks(target: CloudTarget): TargetValidationCheck[] {
    return configChecks(target);
  }

  protected credentials(ctx: ProviderContext): Promise<DigitalOceanCredentials> {
    return readCredentialFields<DigitalOceanCredentials>('digitalocean', ctx, this.opts.resolveSecret, { required: CREDENTIAL_FIELDS });
  }

  protected api(ctx: ProviderContext, creds: DigitalOceanCredentials): DoApi {
    return doApi(creds.token, this.fetch, ctx.signal);
  }

  protected async verifyIdentity(ctx: ProviderContext, creds: DigitalOceanCredentials): Promise<{ check: TargetValidationCheck; identity?: string }> {
    try {
      const r = await this.api(ctx, creds)<{ account: { uuid?: string; status?: string; team?: { uuid?: string; name?: string } } }>('/v2/account');
      const account = r?.account ?? {};
      // The account email is never reported; the team identifies the target.
      const identity = account.team?.name || account.team?.uuid || account.uuid;
      const active = !account.status || account.status === 'active';
      return {
        identity,
        check: active
          ? { name: 'Account access', status: 'ok', message: `Token accepted${identity ? ` for team ${identity}` : ''}.` }
          : { name: 'Account access', status: 'error', message: `The DigitalOcean account is ${account.status}; resources cannot be created.` },
      };
    } catch (err) {
      const message = err instanceof HttpError && err.status === 401 ? 'DigitalOcean rejected the API token.' : safeMessage(err);
      return { check: { name: 'Account access', status: 'error', message } };
    }
  }

  protected override async extraChecks(ctx: ProviderContext, creds: DigitalOceanCredentials, opts: ValidateTargetOptions): Promise<TargetValidationCheck[]> {
    const api = this.api(ctx, creds);
    const missing: { label: string; blocking: boolean }[] = [];
    for (const probe of SCOPE_PROBES) {
      try {
        await api(probe.path);
      } catch (err) {
        if (err instanceof HttpError && err.status === 403) {
          missing.push({ label: probe.label, blocking: probe.kinds.some((k) => opts.serviceKinds?.includes(k)) });
        } else {
          return [{ name: 'Token scopes', status: 'warn', message: `Could not check token scopes: ${safeMessage(err)}` }];
        }
      }
    }
    if (!missing.length) return [{ name: 'Token scopes', status: 'ok', message: 'The token can read VPCs, apps and databases.' }];
    const labels = missing.map((m) => m.label).join(', ');
    return [{ name: 'Token scopes', status: missing.some((m) => m.blocking) ? 'error' : 'warn', message: `The token lacks access to: ${labels}. Grant those scopes (create, read, update, delete).` }];
  }

  protected stateStore(ctx: ProviderContext, creds: DigitalOceanCredentials): StateStore {
    const cfg = digitalOceanConfig(ctx.target);
    return new S3CompatibleStateStore({
      endpoint: spacesEndpoint(cfg.stateRegion),
      region: SPACES_SIGNING_REGION,
      bucket: cfg.stateBucket,
      accessKeyId: creds.spacesAccessKeyId,
      secretAccessKey: creds.spacesSecretAccessKey,
      pathStyle: true,
    });
  }

  protected backend(ctx: ProviderContext, stateKey: string): Record<string, unknown> {
    const cfg = digitalOceanConfig(ctx.target);
    // DigitalOcean documents use_lockfile for Spaces (conditional writes are supported).
    return s3CompatibleBackend({ endpoint: spacesEndpoint(cfg.stateRegion), region: SPACES_SIGNING_REGION, bucket: cfg.stateBucket, key: stateKey, lockfile: true });
  }

  protected rootParts(_ctx: ProviderContext, _req: ResourceRequest): RootParts {
    return rootParts();
  }

  protected runnerEnv(_ctx: ProviderContext, creds: DigitalOceanCredentials): Record<string, string> {
    return {
      DIGITALOCEAN_TOKEN: creds.token,
      SPACES_ACCESS_KEY_ID: creds.spacesAccessKeyId,
      SPACES_SECRET_ACCESS_KEY: creds.spacesSecretAccessKey,
      ...s3BackendEnv(creds.spacesAccessKeyId, creds.spacesSecretAccessKey),
    };
  }

  protected moduleCall(ctx: ProviderContext, req: ResourceRequest): ModuleCall {
    return moduleCall(ctx, req);
  }

  protected override virtualResource(_ctx: ProviderContext, req: ResourceRequest): ResourceOutputs | undefined {
    return virtualIngress(req);
  }

  protected health(ctx: ProviderContext, creds: DigitalOceanCredentials, res: ResourceIdentifier, outputs: ResourceOutputs): Promise<HealthResult> {
    return checkDigitalOceanHealth(res.serviceKind, outputs, {
      api: this.api(ctx, creds),
      creds,
      fetch: this.fetch,
      signal: ctx.signal,
      healthPath: String(outputs.health_check_path || outputs.path_prefix || '/'),
    });
  }

  protected override probe(ctx: ProviderContext, creds: DigitalOceanCredentials, res: ResourceIdentifier, outputs: ResourceOutputs): Promise<boolean | undefined> {
    return probeDigitalOceanExists(res.serviceKind, outputs, { api: this.api(ctx, creds), creds, signal: ctx.signal });
  }

  protected override async logs(ctx: ProviderContext, creds: DigitalOceanCredentials, res: ResourceIdentifier, outputs: ResourceOutputs, limit: number): Promise<LogLine[]> {
    if (res.serviceKind !== 'compute.container-service' || !outputs.service_id) return [];
    return readAppLogs(this.api(ctx, creds), outputs, limit, this.fetch, ctx.signal);
  }

  /** Connection details of a managed database or Valkey cluster (`do-db://<cluster id>`). */
  async readSecret(ctx: ProviderContext, ref: string): Promise<Record<string, string>> {
    if (!ref.startsWith(DB_REF_PREFIX)) {
      throw new ProviderError('DIGITALOCEAN_SECRET_REF_UNSUPPORTED', 'Only do-db:// references are published by the DigitalOcean adapter.', 'VALIDATION_ERROR', 'digitalocean');
    }
    const creds = await this.credentials(ctx);
    try {
      return await readDatabaseConnection(this.api(ctx, creds), ref.slice(DB_REF_PREFIX.length));
    } catch (err) {
      throw this.apiError(err);
    }
  }

  actions(capability: string): ResourceActionDescriptor[] {
    return capability === 'app-platform' ? APP_ACTIONS : [];
  }

  async runAction(ctx: ProviderContext, res: ResourceIdentifier, request: ResourceActionRequest): Promise<ResourceActionResult> {
    if (res.capability !== 'app-platform' || !APP_ACTIONS.some((a) => a.name === request.action)) {
      throw new ProviderError('DIGITALOCEAN_ACTION_UNSUPPORTED', `${request.action} is not available for ${res.capability}.`, 'VALIDATION_ERROR', 'digitalocean');
    }
    const { api, appId, outputs } = await this.appContext(ctx, res);
    try {
      if (request.action === 'redeploy') {
        const r = await api<{ deployment: { id: string } }>(`/v2/apps/${encodeURIComponent(appId)}/deployments`, { method: 'POST', body: { force_build: request.params.forceBuild ?? true } });
        return { reference: r?.deployment.id, status: 'started', message: 'App Platform deployment started.', url: outputs.url ? String(outputs.url) : undefined };
      }
      const r = await api<{ deployment?: { id: string } }>(`/v2/apps/${encodeURIComponent(appId)}/restart`, { method: 'POST', body: { components: [String(outputs.component ?? 'service')] } });
      return { reference: r?.deployment?.id, status: 'started', message: 'Rolling restart started.' };
    } catch (err) {
      throw this.apiError(err);
    }
  }

  async listDeployments(ctx: ProviderContext, res: ResourceIdentifier, limit: number): Promise<ProviderDeployment[]> {
    if (res.capability !== 'app-platform') return [];
    const { api, appId, outputs } = await this.appContext(ctx, res);
    try {
      return await listAppDeployments(api, appId, limit, outputs.url ? String(outputs.url) : undefined);
    } catch (err) {
      throw this.apiError(err);
    }
  }

  private async appContext(ctx: ProviderContext, res: ResourceIdentifier): Promise<{ api: DoApi; appId: string; outputs: ResourceOutputs }> {
    const outputs = await this.knownOutputs(ctx, res);
    const appId = outputs?.service_id ? String(outputs.service_id) : res.providerResourceId;
    if (!appId) throw new ProviderError('DIGITALOCEAN_RESOURCE_MISSING', `${res.resourceId} has not been deployed yet.`, 'VALIDATION_ERROR', 'digitalocean');
    return { api: this.api(ctx, await this.credentials(ctx)), appId, outputs: outputs ?? {} };
  }

  private apiError(err: unknown): ProviderError {
    if (err instanceof ProviderError) return err;
    if (err instanceof HttpError) return new ProviderError(`DIGITALOCEAN_HTTP_${err.status}`, err.message, failureClassForStatus(err.status), 'digitalocean');
    return new ProviderError('DIGITALOCEAN_UNEXPECTED', safeMessage(err), 'UNKNOWN', 'digitalocean');
  }
}
