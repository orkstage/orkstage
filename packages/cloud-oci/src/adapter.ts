// SPDX-License-Identifier: AGPL-3.0-only
import {
  csv,
  HttpError,
  ProviderError,
  failureClassForStatus,
  readCredentialFields,
  safeMessage,
  type CloudCapability,
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
import {
  OpenTofuAdapter,
  S3CompatibleStateStore,
  s3BackendEnv,
  s3CompatibleBackend,
  type ModuleCall,
  type OpenTofuAdapterOptions,
  type RootParts,
  type StateStore,
} from '@orkstage/cloud-tofu';
import { OciClient } from './auth.js';
import { OCI_CAPABILITIES } from './catalog.js';
import { configChecks, endpoints, hasVault, ociConfig, s3Endpoint, type OciCredentials } from './config.js';
import { checkOciHealth, probeOciExists, readContainerLogs } from './health.js';
import { moduleCall, rootParts } from './stacks.js';

const RESTART: ResourceActionDescriptor = { name: 'restart', description: 'Restart every container instance of the service.', params: [] };

/**
 * Oracle Cloud Infrastructure adapter. Resources are provisioned with the OCI OpenTofu modules,
 * one isolated state per resource kept in an Object Storage bucket through the S3 compatibility
 * API. Identity, health, secrets and actions go through the OCI REST APIs with request signing.
 */
export class OciAdapter extends OpenTofuAdapter<OciCredentials> {
  readonly provider = 'oci' as const;
  // Container instances are immutable: a new image replaces them and their load balancer backends.
  protected override readonly routineReplacements = /oci_container_instances_container_instance\.this|oci_load_balancer_backend\.this/;

  constructor(opts: OpenTofuAdapterOptions) {
    super(opts);
  }

  capabilities(): CloudCapability[] {
    return OCI_CAPABILITIES;
  }

  protected configChecks = configChecks;

  protected async credentials(ctx: ProviderContext): Promise<OciCredentials> {
    const creds = await readCredentialFields<OciCredentials>('oci', ctx, this.opts.resolveSecret, {
      required: ['privateKey', 'stateAccessKeyId', 'stateSecretAccessKey'],
    });
    // Keys pasted with escaped line breaks still parse.
    return { ...creds, privateKey: creds.privateKey.replace(/\\n/g, '\n') };
  }

  protected client(ctx: ProviderContext, creds: OciCredentials): OciClient {
    const cfg = ociConfig(ctx.target);
    return new OciClient({ tenancyOcid: cfg.tenancyOcid, userOcid: cfg.userOcid, fingerprint: cfg.fingerprint, privateKey: creds.privateKey }, this.fetch);
  }

  protected async verifyIdentity(ctx: ProviderContext, creds: OciCredentials): Promise<{ check: TargetValidationCheck; identity?: string }> {
    const cfg = ociConfig(ctx.target);
    const name = 'Compartment access';
    try {
      const c = await this.client(ctx, creds).json<{ name?: string; lifecycleState?: string }>('GET', `${endpoints(ctx.region).identity}/compartments/${cfg.compartmentOcid}`, { signal: ctx.signal });
      if (c?.lifecycleState && c.lifecycleState !== 'ACTIVE') {
        return { check: { name, status: 'error', message: `Compartment ${c.name ?? ''} is ${c.lifecycleState}.` } };
      }
      return { check: { name, status: 'ok', message: `Signed in to compartment ${c?.name ?? 'unknown'}.` }, identity: c?.name };
    } catch (err) {
      if (err instanceof ProviderError) return { check: { name, status: 'error', message: err.message } };
      const status = err instanceof HttpError ? err.status : 0;
      const message =
        status === 401 ? 'OCI rejected the request signature. Check userOcid, fingerprint and privateKey, and that the key is uploaded to the user.'
        : status === 404 ? 'The compartment does not exist or this user may not read it.'
        : safeMessage(err);
      return { check: { name, status: 'error', message } };
    }
  }

  protected override async extraChecks(ctx: ProviderContext, _creds: OciCredentials, opts: ValidateTargetOptions): Promise<TargetValidationCheck[]> {
    const wantsPostgres = !opts.serviceKinds || opts.serviceKinds.includes('database.postgresql');
    if (!wantsPostgres || hasVault(ociConfig(ctx.target))) return [];
    return [
      {
        name: 'Vault for database credentials',
        status: 'warn',
        message: 'No vaultOcid and keyOcid on this target. Each PostgreSQL database will create its own vault, which OCI deletes only after a pending period of at least 7 days. Set both to share one vault.',
      },
    ];
  }

  protected stateStore(ctx: ProviderContext, creds: OciCredentials): StateStore {
    const cfg = ociConfig(ctx.target);
    return new S3CompatibleStateStore({
      endpoint: s3Endpoint(cfg.namespace, ctx.region),
      region: ctx.region,
      bucket: cfg.stateBucket,
      accessKeyId: creds.stateAccessKeyId,
      secretAccessKey: creds.stateSecretAccessKey,
      pathStyle: true,
    });
  }

  protected backend(ctx: ProviderContext, stateKey: string): Record<string, unknown> {
    const cfg = ociConfig(ctx.target);
    // No S3 native locking: the platform runs one operation per resource at a time.
    return s3CompatibleBackend({ endpoint: s3Endpoint(cfg.namespace, ctx.region), region: ctx.region, bucket: cfg.stateBucket, key: stateKey, pathStyle: true });
  }

  protected rootParts(ctx: ProviderContext, _req: ResourceRequest): RootParts {
    return rootParts(ctx);
  }

  protected runnerEnv(_ctx: ProviderContext, creds: OciCredentials): Record<string, string> {
    return { ...s3BackendEnv(creds.stateAccessKeyId, creds.stateSecretAccessKey), TF_VAR_oci_private_key: creds.privateKey };
  }

  protected moduleCall(ctx: ProviderContext, req: ResourceRequest): ModuleCall {
    return moduleCall(ctx, req);
  }

  protected health(ctx: ProviderContext, creds: OciCredentials, res: ResourceIdentifier, outputs: ResourceOutputs): Promise<HealthResult> {
    return checkOciHealth(this.client(ctx, creds), res.serviceKind, outputs, ctx.region, { fetch: this.fetch, signal: ctx.signal });
  }

  protected override probe(ctx: ProviderContext, creds: OciCredentials, res: ResourceIdentifier, outputs: ResourceOutputs): Promise<boolean | undefined> {
    return probeOciExists(this.client(ctx, creds), res.serviceKind, outputs, ctx.region, ctx.signal);
  }

  protected override logs(ctx: ProviderContext, creds: OciCredentials, res: ResourceIdentifier, outputs: ResourceOutputs, limit: number): Promise<LogLine[]> {
    if (res.serviceKind !== 'compute.container-service') return Promise.resolve([]);
    return readContainerLogs(this.client(ctx, creds), outputs, ctx.region, limit, ctx.signal);
  }

  /** Reads a Vault secret published as `secret_ref` (JSON credentials) and returns its fields. */
  async readSecret(ctx: ProviderContext, ref: string): Promise<Record<string, string>> {
    if (!/^ocid1\.vaultsecret\./.test(ref)) {
      throw new ProviderError('OCI_SECRET_REF_INVALID', 'The secret reference is not an OCI Vault secret OCID.', 'VALIDATION_ERROR', 'oci');
    }
    const creds = await this.credentials(ctx);
    let bundle: { secretBundleContent?: { contentType?: string; content?: string } } | null;
    try {
      bundle = await this.client(ctx, creds).json('GET', `${endpoints(ctx.region).secrets}/secretbundles/${ref}`, { signal: ctx.signal });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 0;
      throw new ProviderError('OCI_SECRET_UNREADABLE', `The Vault secret could not be read (HTTP ${status || 'error'}).`, status ? failureClassForStatus(status) : 'NETWORK_ERROR', 'oci');
    }
    const content = bundle?.secretBundleContent?.content ?? '';
    let fields: Record<string, unknown>;
    try {
      fields = JSON.parse(Buffer.from(content, 'base64').toString('utf8')) as Record<string, unknown>;
    } catch {
      throw new ProviderError('OCI_SECRET_NOT_JSON', 'The Vault secret does not hold JSON credentials.', 'VALIDATION_ERROR', 'oci');
    }
    return Object.fromEntries(
      Object.entries(fields)
        .filter(([, v]) => typeof v === 'string' || typeof v === 'number')
        .map(([k, v]) => [k, String(v)]),
    );
  }

  actions(capability: string): ResourceActionDescriptor[] {
    return capability === 'container-instances' ? [RESTART] : [];
  }

  async runAction(ctx: ProviderContext, res: ResourceIdentifier, request: ResourceActionRequest): Promise<ResourceActionResult> {
    if (res.capability !== 'container-instances' || request.action !== 'restart') {
      throw new ProviderError('OCI_ACTION_NOT_SUPPORTED', `${request.action} is not available for ${res.capability}.`, 'VALIDATION_ERROR', 'oci');
    }
    const outputs = await this.knownOutputs(ctx, res);
    const ids = csv(outputs?.instance_ids);
    if (!ids.length) {
      throw new ProviderError('OCI_NOTHING_TO_RESTART', `${res.resourceId} has no running container instances.`, 'VALIDATION_ERROR', 'oci');
    }
    const client = this.client(ctx, await this.credentials(ctx));
    let reference: string | undefined;
    for (const id of ids) {
      const r = await client.request('POST', `${endpoints(ctx.region).containers}/containerInstances/${id}/actions/restart`, { signal: ctx.signal });
      if (!r.ok) {
        throw new ProviderError('OCI_RESTART_FAILED', `OCI refused the restart (HTTP ${r.status}).`, failureClassForStatus(r.status), 'oci');
      }
      reference ??= r.headers.get('opc-work-request-id') ?? undefined;
    }
    return { reference, status: 'started', message: `Restart requested for ${ids.length} container instance(s).` };
  }
}
