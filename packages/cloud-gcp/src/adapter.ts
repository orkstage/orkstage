// SPDX-License-Identifier: AGPL-3.0-only
import {
  failureClassForStatus,
  HttpError,
  ProviderError,
  readCredentialFields,
  safeMessage,
  type BackupInfo,
  type CloudCapability,
  type CloudTarget,
  type HealthResult,
  type LogLine,
  type ProviderContext,
  type ResourceActionDescriptor,
  type ResourceActionRequest,
  type ResourceActionResult,
  type ResourceIdentifier,
  type ResourceOutputs,
  type ResourceRequest,
  type TargetValidationCheck,
  type ValidateTargetOptions,
} from '@orkstage/cloud-core';
import { OpenTofuAdapter, type ModuleCall, type OpenTofuAdapterOptions, type RootParts, type StateStore } from '@orkstage/cloud-tofu';
import { gcpApi, GcpTokenSource, type GcpApi } from './auth.js';
import { GCP_CAPABILITIES } from './catalog.js';
import { readGcpBackups } from './backups.js';
import { gcpConfig, gcpConfigChecks, type GcpCredentials } from './config.js';
import { accessSecret, cloudRunLogs, gcpHealth, gcpProbe, redeployCloudRun } from './health.js';
import { GcsStateStore, gcsBackend } from './state.js';
import { builtinIngress, moduleCall, rootParts, VIRTUAL_CAPABILITIES } from './stacks.js';

/** APIs each service kind needs enabled in the project. */
export const APIS_BY_KIND: Record<string, string[]> = {
  network: ['compute.googleapis.com', 'servicenetworking.googleapis.com'],
  'compute.container-service': ['run.googleapis.com', 'iam.googleapis.com', 'secretmanager.googleapis.com'],
  'database.postgresql': ['sqladmin.googleapis.com', 'secretmanager.googleapis.com', 'servicenetworking.googleapis.com'],
  'cache.redis': ['redis.googleapis.com', 'secretmanager.googleapis.com'],
  'object-storage': ['storage.googleapis.com'],
};

const REDEPLOY: ResourceActionDescriptor = {
  name: 'redeploy',
  description: 'Start a new Cloud Run revision with the current image and settings, replacing every running instance.',
  params: [],
};

/**
 * Google Cloud adapter. Resources are provisioned with OpenTofu modules (one isolated state per
 * resource in the customer's GCS bucket); health, logs, secrets and redeploys go through the
 * Google Cloud REST APIs with an OAuth token minted from the service account key.
 */
export class GcpAdapter extends OpenTofuAdapter<GcpCredentials> {
  readonly provider = 'gcp' as const;
  private readonly tokens: GcpTokenSource;

  constructor(opts: OpenTofuAdapterOptions) {
    super(opts);
    this.tokens = new GcpTokenSource(this.fetch);
  }

  capabilities(_target: CloudTarget): CloudCapability[] {
    return GCP_CAPABILITIES;
  }

  protected configChecks(target: CloudTarget): TargetValidationCheck[] {
    return gcpConfigChecks(target);
  }

  protected credentials(ctx: ProviderContext): Promise<GcpCredentials> {
    return readCredentialFields<GcpCredentials>('gcp', ctx, this.opts.resolveSecret, { required: ['client_email', 'private_key'] });
  }

  protected async verifyIdentity(ctx: ProviderContext, creds: GcpCredentials): Promise<{ check: TargetValidationCheck; identity?: string }> {
    const { projectId } = gcpConfig(ctx.target);
    let api: GcpApi;
    try {
      api = await this.api(ctx, creds);
    } catch (err) {
      return { check: { name: 'Service account key', status: 'error', message: `Google rejected the service account key: ${safeMessage(err)}` } };
    }
    try {
      const project = await api<{ projectId?: string; state?: string }>(`https://cloudresourcemanager.googleapis.com/v3/projects/${encodeURIComponent(projectId)}`, { allow404: true });
      if (!project) return { check: { name: 'Project access', status: 'error', message: `Project ${projectId} was not found.` } };
      if (project.state && project.state !== 'ACTIVE') {
        return { check: { name: 'Project access', status: 'error', message: `Project ${projectId} is ${project.state}.` }, identity: projectId };
      }
      return { check: { name: 'Project access', status: 'ok', message: `Connected to project ${projectId}.` }, identity: projectId };
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 0;
      const message =
        status === 403
          ? `The service account cannot read project ${projectId} (it needs resourcemanager.projects.get, for example through roles/browser), or the project does not exist.`
          : safeMessage(err);
      return { check: { name: 'Project access', status: 'error', message } };
    }
  }

  protected override async extraChecks(ctx: ProviderContext, creds: GcpCredentials, opts: ValidateTargetOptions): Promise<TargetValidationCheck[]> {
    const { projectId } = gcpConfig(ctx.target);
    const checks: TargetValidationCheck[] = [];
    if (creds.project_id && creds.project_id !== projectId) {
      checks.push({ name: 'Key project', status: 'warn', message: `The key belongs to project ${creds.project_id}; it deploys into ${projectId} only as far as its roles there allow.` });
    }
    const all = [...new Set(Object.values(APIS_BY_KIND).flat())];
    const needed = new Set((opts.serviceKinds ?? []).flatMap((k) => APIS_BY_KIND[k] ?? []));
    try {
      const api = await this.api(ctx, creds);
      const query = all.map((s) => `names=${encodeURIComponent(`projects/${projectId}/services/${s}`)}`).join('&');
      const r = await api<{ services?: { name?: string; state?: string }[] }>(`https://serviceusage.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/services:batchGet?${query}`);
      const enabled = new Set((r?.services ?? []).filter((s) => s.state === 'ENABLED').map((s) => String(s.name).split('/').pop()));
      const disabled = all.filter((s) => !enabled.has(s));
      const blocking = disabled.filter((s) => needed.has(s));
      if (!disabled.length) checks.push({ name: 'APIs', status: 'ok', message: 'Every API the modules use is enabled.' });
      else
        checks.push({
          name: 'APIs',
          status: blocking.length ? 'error' : 'warn',
          message: `Not enabled: ${disabled.join(', ')}. Enable with: gcloud services enable ${disabled.join(' ')} --project ${projectId}`,
        });
    } catch (err) {
      checks.push({ name: 'APIs', status: 'warn', message: `Could not read enabled APIs (needs serviceusage.services.get): ${safeMessage(err)}` });
    }
    return checks;
  }

  protected stateStore(ctx: ProviderContext, creds: GcpCredentials): StateStore {
    return new GcsStateStore(gcpConfig(ctx.target).stateBucket, () => this.tokens.token(creds, ctx.signal), this.fetch);
  }

  protected backend(ctx: ProviderContext, stateKey: string): Record<string, unknown> {
    return gcsBackend(gcpConfig(ctx.target).stateBucket, stateKey);
  }

  protected rootParts(ctx: ProviderContext, req: ResourceRequest): RootParts {
    return rootParts(ctx, req);
  }

  /** The key JSON itself: both the google provider and the gcs backend read GOOGLE_CREDENTIALS. */
  protected runnerEnv(_ctx: ProviderContext, creds: GcpCredentials): Record<string, string> {
    return { GOOGLE_CREDENTIALS: JSON.stringify(creds) };
  }

  protected moduleCall(ctx: ProviderContext, req: ResourceRequest): ModuleCall {
    return moduleCall(ctx, req);
  }

  protected override virtualResource(_ctx: ProviderContext, req: ResourceRequest): ResourceOutputs | undefined {
    return VIRTUAL_CAPABILITIES.has(req.capability) ? builtinIngress(req) : undefined;
  }

  protected async health(ctx: ProviderContext, creds: GcpCredentials, res: ResourceIdentifier, outputs: ResourceOutputs): Promise<HealthResult> {
    return gcpHealth(await this.api(ctx, creds), res.serviceKind, outputs, gcpConfig(ctx.target).projectId, { fetch: this.fetch, signal: ctx.signal });
  }

  /** Backups of a Cloud SQL for PostgreSQL instance (open item 18). */
  async getBackups(ctx: ProviderContext, res: ResourceIdentifier): Promise<BackupInfo | null> {
    if (res.serviceKind !== 'database.postgresql') return null;
    const outputs = res.outputs && Object.keys(res.outputs).length ? res.outputs : (await this.getResource(ctx, res)).outputs;
    return readGcpBackups(await this.api(ctx, await this.credentials(ctx)), outputs, gcpConfig(ctx.target).projectId);
  }

  protected override async probe(ctx: ProviderContext, creds: GcpCredentials, res: ResourceIdentifier, outputs: ResourceOutputs): Promise<boolean | undefined> {
    if (res.serviceKind === 'ingress') return undefined;
    return gcpProbe(await this.api(ctx, creds), res.serviceKind, outputs, gcpConfig(ctx.target).projectId);
  }

  protected override async logs(ctx: ProviderContext, creds: GcpCredentials, res: ResourceIdentifier, outputs: ResourceOutputs, limit: number): Promise<LogLine[]> {
    if (res.serviceKind !== 'compute.container-service') return [];
    return cloudRunLogs(await this.api(ctx, creds), gcpConfig(ctx.target).projectId, outputs, limit);
  }

  /** Reads a Secret Manager `secret_ref` published by the postgres or redis module. */
  async readSecret(ctx: ProviderContext, ref: string): Promise<Record<string, string>> {
    return accessSecret(await this.api(ctx, await this.credentials(ctx)), ref);
  }

  actions(capability: string): ResourceActionDescriptor[] {
    return capability === 'cloud-run' ? [REDEPLOY] : [];
  }

  async runAction(ctx: ProviderContext, res: ResourceIdentifier, request: ResourceActionRequest): Promise<ResourceActionResult> {
    if (request.action !== 'redeploy' || res.capability !== 'cloud-run') {
      throw new ProviderError('GCP_ACTION_UNSUPPORTED', `${request.action} is not available for ${res.capability}.`, 'VALIDATION_ERROR', 'gcp');
    }
    const outputs = await this.knownOutputs(ctx, res);
    if (!outputs?.service_id) throw new ProviderError('GCP_RESOURCE_MISSING', `${res.resourceId} has no Cloud Run service yet.`, 'VALIDATION_ERROR', 'gcp');
    try {
      const reference = await redeployCloudRun(await this.api(ctx, await this.credentials(ctx)), String(outputs.service_id));
      return { status: 'started', reference, message: 'New Cloud Run revision rolling out.', ...(outputs.url ? { url: String(outputs.url) } : {}) };
    } catch (err) {
      if (err instanceof HttpError) throw new ProviderError('GCP_REDEPLOY_FAILED', err.message, failureClassForStatus(err.status), 'gcp');
      throw err;
    }
  }

  private async api(ctx: ProviderContext, creds: GcpCredentials): Promise<GcpApi> {
    return gcpApi(this.fetch, await this.tokens.token(creds, ctx.signal), ctx.signal);
  }
}
