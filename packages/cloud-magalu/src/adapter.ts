// SPDX-License-Identifier: AGPL-3.0-only
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
  type ResourceActionDescriptor,
  type ResourceActionRequest,
  type ResourceActionResult,
  type ResourceIdentifier,
  type ResourceOutputs,
  type ResourceRequest,
  type TargetValidationCheck,
} from '@orkstage/cloud-core';
import {
  OpenTofuAdapter,
  s3BackendEnv,
  s3CompatibleBackend,
  S3CompatibleStateStore,
  stateKeyFor,
  type ModuleCall,
  type RootParts,
  type StateStore,
} from '@orkstage/cloud-tofu';
import { MAGALU_CAPABILITIES } from './catalog.js';
import { configChecks, magaluConfig, objectStorageEndpoint, type MagaluCredentials } from './config.js';
import { apiGet, apiPost, checkMagaluHealth, probeMagaluExists, readInitLogs, type MagaluApi } from './health.js';
import { moduleCall, rootParts } from './stacks.js';

const RESTART: ResourceActionDescriptor = { name: 'restart', description: 'Reboots every virtual machine of the service.', params: [] };

const SECRET_REF = /^mgc-db:\/\/([a-z0-9-]+)\/(.+)$/;

type TfState = {
  resources?: { mode: string; type: string; name: string; instances?: { attributes?: Record<string, unknown> }[] }[];
  outputs?: { all?: { value?: Record<string, unknown> } };
};

/**
 * Magalu Cloud adapter. Resources are provisioned with the MagaluCloud/mgc OpenTofu provider, one
 * isolated state per resource kept in the customer's Object Storage bucket. The API key and the
 * Object Storage key pair reach OpenTofu only as runner environment variables (`TF_VAR_*`, since
 * the provider reads them from configuration). Health, existence and restarts use the regional
 * REST API with the `X-API-Key` header.
 */
export class MagaluAdapter extends OpenTofuAdapter<MagaluCredentials> {
  readonly provider = 'magalu' as const;
  /** VMs are replaced on every image or environment change; that is how a rollout happens here. */
  protected override readonly routineReplacements = /(^|\.)(mgc_virtual_machine_instances\.this|mgc_network_public_ips_attach\.vm)(\[\d+\])?$/;

  capabilities(_target: CloudTarget): CloudCapability[] {
    return MAGALU_CAPABILITIES;
  }

  protected configChecks(target: CloudTarget): TargetValidationCheck[] {
    return configChecks(target);
  }

  protected credentials(ctx: ProviderContext): Promise<MagaluCredentials> {
    return readCredentialFields<MagaluCredentials>('magalu', ctx, this.opts.resolveSecret, { required: ['apiKey', 'stateAccessKeyId', 'stateSecretAccessKey'] });
  }

  protected async verifyIdentity(ctx: ProviderContext, creds: MagaluCredentials): Promise<{ check: TargetValidationCheck; identity?: string }> {
    try {
      const r = await apiGet<{ vpcs?: { tenant_id?: string }[] }>(this.api(ctx, creds), '/network/v0/vpcs');
      const tenant = r?.vpcs?.find((v) => v.tenant_id)?.tenant_id;
      const identity = tenant && /@/.test(tenant) ? '<email>' : tenant;
      return {
        check: { name: 'API key', status: 'ok', message: identity ? `API key accepted for tenant ${identity}.` : `API key accepted in ${ctx.region}.` },
        identity,
      };
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 0;
      const message = status === 401 || status === 403 ? 'The API key was rejected. Create an API key with access to the target region.' : safeMessage(err);
      return { check: { name: 'API key', status: 'error', message } };
    }
  }

  protected stateStore(ctx: ProviderContext, creds: MagaluCredentials): StateStore {
    return new S3CompatibleStateStore({
      endpoint: objectStorageEndpoint(ctx.region),
      region: ctx.region,
      bucket: magaluConfig(ctx.target).stateBucket,
      accessKeyId: creds.stateAccessKeyId,
      secretAccessKey: creds.stateSecretAccessKey,
      pathStyle: true,
    });
  }

  protected backend(ctx: ProviderContext, stateKey: string): Record<string, unknown> {
    return s3CompatibleBackend({ endpoint: objectStorageEndpoint(ctx.region), region: ctx.region, bucket: magaluConfig(ctx.target).stateBucket, key: stateKey });
  }

  protected rootParts(ctx: ProviderContext, req: ResourceRequest): RootParts {
    return rootParts(ctx, req);
  }

  protected runnerEnv(_ctx: ProviderContext, creds: MagaluCredentials): Record<string, string> {
    return {
      TF_VAR_mgc_api_key: creds.apiKey,
      TF_VAR_mgc_key_pair_id: creds.stateAccessKeyId,
      TF_VAR_mgc_key_pair_secret: creds.stateSecretAccessKey,
      ...s3BackendEnv(creds.stateAccessKeyId, creds.stateSecretAccessKey),
    };
  }

  protected moduleCall(ctx: ProviderContext, req: ResourceRequest): ModuleCall {
    return moduleCall(ctx, req);
  }

  protected health(ctx: ProviderContext, creds: MagaluCredentials, res: ResourceIdentifier, outputs: ResourceOutputs): Promise<HealthResult> {
    return checkMagaluHealth(res.serviceKind, outputs, this.api(ctx, creds), creds);
  }

  protected override probe(ctx: ProviderContext, creds: MagaluCredentials, res: ResourceIdentifier, outputs: ResourceOutputs): Promise<boolean | undefined> {
    return probeMagaluExists(res.serviceKind, outputs, this.api(ctx, creds), creds);
  }

  protected override logs(ctx: ProviderContext, creds: MagaluCredentials, res: ResourceIdentifier, outputs: ResourceOutputs, limit: number): Promise<LogLine[]> {
    return res.serviceKind === 'compute.container-service' ? readInitLogs(outputs, this.api(ctx, creds), limit) : Promise.resolve([]);
  }

  /**
   * Resolves `mgc-db://<name>/<id>`. DBaaS never returns the master password, so it is read from
   * the generated value in that database's OpenTofu state (the customer's own bucket).
   */
  async readSecret(ctx: ProviderContext, ref: string): Promise<Record<string, string>> {
    const m = SECRET_REF.exec(ref);
    if (!m) throw new ProviderError('MAGALU_SECRET_REF_INVALID', 'Not a Magalu Cloud secret reference.', 'VALIDATION_ERROR', 'magalu');
    const [, name, id] = m as unknown as [string, string, string];
    const raw = await this.stateStore(ctx, await this.credentials(ctx)).get(stateKeyFor(name), ctx.signal);
    const state = raw ? (JSON.parse(raw) as TfState) : undefined;
    const out = state?.outputs?.all?.value ?? {};
    const password = state?.resources?.find((r) => r.mode === 'managed' && r.type === 'random_password' && r.name === 'master')?.instances?.[0]?.attributes?.result;
    if (!state || out.instance_id !== id || typeof password !== 'string') {
      throw new ProviderError('MAGALU_SECRET_NOT_FOUND', `No credentials recorded for database ${name} in this target and region.`, 'VALIDATION_ERROR', 'magalu');
    }
    const host = String(out.host ?? '');
    const port = String(out.port ?? '5432');
    const database = String(out.database ?? 'postgres');
    const username = String(out.username ?? '');
    return {
      host,
      port,
      database,
      username,
      password,
      url: `postgresql://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}/${database}`,
    };
  }

  actions(capability: string): ResourceActionDescriptor[] {
    return capability === 'vm-docker' ? [RESTART] : [];
  }

  async runAction(ctx: ProviderContext, res: ResourceIdentifier, request: ResourceActionRequest): Promise<ResourceActionResult> {
    if (res.capability !== 'vm-docker' || request.action !== 'restart') {
      throw new ProviderError('MAGALU_ACTION_UNSUPPORTED', `${request.action} is not available for ${res.capability}.`, 'VALIDATION_ERROR', 'magalu');
    }
    const outputs = await this.knownOutputs(ctx, res);
    const ids = String(outputs?.instance_ids ?? '').split(',').filter(Boolean);
    if (!ids.length) throw new ProviderError('MAGALU_RESOURCE_MISSING', `${res.resourceId} has no virtual machines to restart.`, 'VALIDATION_ERROR', 'magalu');
    const api = this.api(ctx, await this.credentials(ctx));
    try {
      for (const id of ids) await apiPost(api, `/compute/v1/instances/${encodeURIComponent(id)}/reboot`);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 0;
      throw new ProviderError('MAGALU_ACTION_FAILED', safeMessage(err), status ? failureClassForStatus(status) : 'NETWORK_ERROR', 'magalu');
    }
    return { status: 'started', message: `Reboot requested for ${ids.length} VM(s).` };
  }

  private api(ctx: ProviderContext, creds: MagaluCredentials): MagaluApi {
    return { region: ctx.region, apiKey: creds.apiKey, fetch: this.fetch, signal: ctx.signal };
  }
}
