import {
  ProviderError,
  readCredentialFields,
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
import { ARM, AzureAuth, SCOPES, azureJson } from './auth.js';
import { AZURE_CAPABILITIES } from './catalog.js';
import { azureConfig, configChecks, type AzureCredentials } from './config.js';
import { armUrl, checkAzureHealth, containerAppLogs, getArm, mainResourceId, type ArmReader } from './health.js';
import { RESOURCE_PROVIDERS, VIRTUAL_CAPABILITIES, isKeyVaultSecretId, moduleCall, rootParts, virtualIngress } from './stacks.js';
import { AzureBlobStateStore } from './state.js';

const CONTAINER_APP_ACTIONS: ResourceActionDescriptor[] = [
  { name: 'restart', description: 'Restart the active revision of the container app (its replicas are recreated).', params: [] },
];

/**
 * Microsoft Azure through OpenTofu (`azurerm`) with a service principal and client secret.
 * State lives in the customer's Blob container; health, secrets, logs and actions use Azure
 * Resource Manager, Key Vault and Log Analytics REST APIs with Microsoft Entra tokens.
 */
export class AzureAdapter extends OpenTofuAdapter<AzureCredentials> {
  readonly provider = 'azure' as const;
  /** Waits for role propagation are recreated when grants change; nothing is lost. */
  protected override readonly routineReplacements = /(^|\.)time_sleep\.[^.]+$/;
  private readonly auth: AzureAuth;

  constructor(opts: OpenTofuAdapterOptions) {
    super(opts);
    this.auth = new AzureAuth(this.fetch);
  }

  capabilities(_target: CloudTarget): CloudCapability[] {
    return AZURE_CAPABILITIES;
  }

  protected configChecks(target: CloudTarget): TargetValidationCheck[] {
    return configChecks(target);
  }

  protected credentials(ctx: ProviderContext): Promise<AzureCredentials> {
    return readCredentialFields<AzureCredentials>('azure', ctx, this.opts.resolveSecret, { required: ['clientSecret'], singleField: 'clientSecret' });
  }

  private token(ctx: ProviderContext, creds: AzureCredentials, scope: (typeof SCOPES)[keyof typeof SCOPES]): Promise<string> {
    return this.auth.token(azureConfig(ctx.target), creds, scope, ctx.signal);
  }

  private arm(ctx: ProviderContext, creds: AzureCredentials): ArmReader {
    return { fetch: this.fetch, token: () => this.token(ctx, creds, SCOPES.management), signal: ctx.signal };
  }

  protected async verifyIdentity(ctx: ProviderContext, creds: AzureCredentials): Promise<{ check: TargetValidationCheck; identity?: string }> {
    const { subscriptionId } = azureConfig(ctx.target);
    try {
      const token = await this.token(ctx, creds, SCOPES.management);
      const sub = await azureJson<{ subscriptionId?: string; displayName?: string; state?: string }>(
        this.fetch,
        `${ARM}/subscriptions/${encodeURIComponent(subscriptionId)}?api-version=2022-12-01`,
        token,
        { signal: ctx.signal },
      );
      const identity = sub?.displayName || subscriptionId;
      if (sub?.state && sub.state !== 'Enabled') {
        return { check: { name: 'Subscription access', status: 'error', message: `Subscription ${identity} is ${sub.state}.` }, identity };
      }
      return { check: { name: 'Subscription access', status: 'ok', message: `Service principal can read subscription ${identity}.` }, identity };
    } catch (err) {
      const status = err instanceof ProviderError ? (err.details.status as number | undefined) : undefined;
      const message =
        status === 403 || status === 404 ? 'The service principal has no role on this subscription. Assign Contributor and User Access Administrator (or Owner).'
        : err instanceof ProviderError ? err.message
        : 'Could not reach Microsoft Entra or Azure Resource Manager.';
      return { check: { name: 'Subscription access', status: 'error', message } };
    }
  }

  protected stateStore(ctx: ProviderContext, creds: AzureCredentials): StateStore {
    const cfg = azureConfig(ctx.target);
    return new AzureBlobStateStore({ account: cfg.stateStorageAccount, container: cfg.stateContainer, fetch: this.fetch, token: () => this.token(ctx, creds, SCOPES.storage) });
  }

  protected backend(ctx: ProviderContext, stateKey: string): Record<string, unknown> {
    const cfg = azureConfig(ctx.target);
    return {
      azurerm: {
        resource_group_name: cfg.stateResourceGroup,
        storage_account_name: cfg.stateStorageAccount,
        container_name: cfg.stateContainer,
        key: stateKey,
        use_azuread_auth: true,
        use_cli: false,
      },
    };
  }

  protected rootParts(ctx: ProviderContext, req: ResourceRequest): RootParts {
    return rootParts(ctx, req);
  }

  protected runnerEnv(ctx: ProviderContext, creds: AzureCredentials): Record<string, string> {
    const cfg = azureConfig(ctx.target);
    return { ARM_TENANT_ID: cfg.tenantId, ARM_CLIENT_ID: cfg.clientId, ARM_CLIENT_SECRET: creds.clientSecret, ARM_SUBSCRIPTION_ID: cfg.subscriptionId };
  }

  protected moduleCall(ctx: ProviderContext, req: ResourceRequest): ModuleCall {
    return moduleCall(ctx, req);
  }

  protected override virtualResource(_ctx: ProviderContext, req: ResourceRequest): ResourceOutputs | undefined {
    return VIRTUAL_CAPABILITIES.has(req.capability) ? virtualIngress(req) : undefined;
  }

  protected health(ctx: ProviderContext, creds: AzureCredentials, res: ResourceIdentifier, outputs: ResourceOutputs): Promise<HealthResult> {
    return checkAzureHealth(this.arm(ctx, creds), res.serviceKind, outputs);
  }

  protected override async probe(ctx: ProviderContext, creds: AzureCredentials, _res: ResourceIdentifier, outputs: ResourceOutputs): Promise<boolean | undefined> {
    const id = mainResourceId(outputs);
    if (!id) return undefined;
    try {
      return (await getArm(this.arm(ctx, creds), id, true)) !== null;
    } catch {
      return undefined; // throttling or permissions say nothing about existence
    }
  }

  protected override async logs(ctx: ProviderContext, creds: AzureCredentials, res: ResourceIdentifier, outputs: ResourceOutputs, limit: number): Promise<LogLine[]> {
    if (res.serviceKind !== 'compute.container-service' || !outputs.log_workspace_id || !outputs.name) return [];
    const token = await this.token(ctx, creds, SCOPES.logs);
    return containerAppLogs(this.fetch, token, String(outputs.log_workspace_id), String(outputs.name), limit, ctx.signal);
  }

  /** Warns about resource providers the subscription has not registered yet. */
  protected override async extraChecks(ctx: ProviderContext, creds: AzureCredentials, opts: ValidateTargetOptions): Promise<TargetValidationCheck[]> {
    const { subscriptionId } = azureConfig(ctx.target);
    const kinds = opts.serviceKinds?.length ? opts.serviceKinds : Object.keys(RESOURCE_PROVIDERS);
    const needed = [...new Set(kinds.flatMap((k) => RESOURCE_PROVIDERS[k] ?? []))].sort();
    if (!needed.length) return [];
    let list: { value?: { namespace: string; registrationState?: string }[] } | null;
    try {
      list = await azureJson(this.fetch, `${ARM}/subscriptions/${encodeURIComponent(subscriptionId)}/providers?api-version=2021-04-01`, await this.token(ctx, creds, SCOPES.management), { signal: ctx.signal });
    } catch {
      return [{ name: 'Resource providers', status: 'skipped', message: 'Could not list resource provider registrations.' }];
    }
    const registered = new Set((list?.value ?? []).filter((p) => p.registrationState === 'Registered').map((p) => p.namespace.toLowerCase()));
    const missing = needed.filter((n) => !registered.has(n.toLowerCase()));
    if (!missing.length) return [{ name: 'Resource providers', status: 'ok', message: `Registered: ${needed.join(', ')}.` }];
    return [{
      name: 'Resource providers',
      status: 'warn',
      message: `Not registered yet: ${missing.join(', ')}. The first deployment registers them, which needs the register action on the subscription (Contributor has it).`,
    }];
  }

  /**
   * Reads a Key Vault secret this adapter published (`https://<vault>.vault.azure.net/secrets/<name>`).
   * JSON values become their fields; anything else is returned as `password`.
   */
  async readSecret(ctx: ProviderContext, ref: string): Promise<Record<string, string>> {
    if (!isKeyVaultSecretId(ref)) {
      throw new ProviderError('AZURE_SECRET_REF_INVALID', 'Only Azure Key Vault secret ids can be read by the Azure adapter.', 'VALIDATION_ERROR', 'azure');
    }
    const creds = await this.credentials(ctx);
    const token = await this.token(ctx, creds, SCOPES.vault);
    const secret = await azureJson<{ value?: string }>(this.fetch, `${ref.replace(/\/$/, '')}?api-version=7.5`, token, { signal: ctx.signal });
    const value = secret?.value ?? '';
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => [k, String(v)]));
      }
    } catch {
      // not JSON: a bare secret value
    }
    return { password: value };
  }

  actions(capability: string): ResourceActionDescriptor[] {
    return capability === 'container-apps' ? CONTAINER_APP_ACTIONS : [];
  }

  async runAction(ctx: ProviderContext, res: ResourceIdentifier, request: ResourceActionRequest): Promise<ResourceActionResult> {
    if (!this.actions(res.capability).some((a) => a.name === request.action)) {
      throw new ProviderError('AZURE_ACTION_UNSUPPORTED', `${request.action} is not available for ${res.capability}.`, 'VALIDATION_ERROR', 'azure');
    }
    const outputs = await this.knownOutputs(ctx, res);
    const appId = outputs?.service_id ? String(outputs.service_id) : '';
    if (!appId) throw new ProviderError('AZURE_RESOURCE_MISSING', `${res.resourceId} has no container app to restart.`, 'VALIDATION_ERROR', 'azure');
    const creds = await this.credentials(ctx);
    const arm = this.arm(ctx, creds);
    const app = await getArm(arm, appId);
    const revision = app?.properties?.latestReadyRevisionName || app?.properties?.latestRevisionName;
    if (!revision) throw new ProviderError('AZURE_NO_REVISION', `${res.resourceId} has no active revision to restart.`, 'VALIDATION_ERROR', 'azure');
    const url = armUrl(appId).replace('?', `/revisions/${encodeURIComponent(revision)}/restart?`);
    await azureJson(this.fetch, url, await arm.token(), { method: 'POST', signal: ctx.signal });
    return { reference: revision, status: 'started', message: `Restarting revision ${revision}.`, url: outputs?.url ? String(outputs.url) : undefined };
  }
}
