// SPDX-License-Identifier: AGPL-3.0-only
import {
  ProviderError,
  csv,
  readCredentialFields,
  type CloudCapability,
  type CloudTarget,
  type DriftChange,
  type HealthResult,
  type ProviderContext,
  type ResourceActionDescriptor,
  type ResourceActionRequest,
  type ResourceActionResult,
  type ResourceIdentifier,
  type ResourceOutputs,
  type ResourcePlan,
  type ResourceRequest,
  type ResourceResult,
  type TargetValidationCheck,
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
import {
  VultrApi,
  statusOf,
  type VultrCredentials,
  type VultrDatabase,
  type VultrDatabasePlan,
  type VultrLoadBalancer,
  type VultrObjectStorage,
  type VultrObjectStorageCluster,
  type VultrObjectStorageTier,
} from './api.js';
import { VULTR_CAPABILITIES } from './catalog.js';
import { STATE_SIGNING_REGION, stateEndpointUrl, vultrConfig, vultrConfigChecks } from './config.js';
import { checkVultrHealth, headBucketS3, probeVultrExists, type HeadBucket } from './health.js';
import { SIZE_RAM_MB, databaseNodes, pickDatabasePlan, pickObjectStorage, sizeKey } from './sizing.js';
import { DB_REF, OBJSTORE_REF, overridesOf, vultrModuleCall, vultrRootParts, type VultrResolved } from './stacks.js';

export interface VultrAdapterOptions extends OpenTofuAdapterOptions {
  /** Bucket HEAD used by object storage health checks (tests pass a fake). */
  headBucket?: HeadBucket;
}

const RESTART: ResourceActionDescriptor = {
  name: 'restart',
  description: 'Reboot every instance of the service; Docker starts the container again.',
  params: [],
};

/**
 * Vultr through OpenTofu (vultr/vultr provider). State lives in the customer's own Vultr Object
 * Storage bucket; the API key and the state keys reach the runner only as environment variables.
 * Container services run as Docker on cloud compute instances, attached to the ingress load
 * balancer through the API after each apply.
 */
export class VultrAdapter extends OpenTofuAdapter<VultrCredentials> {
  readonly provider = 'vultr' as const;
  protected override readonly routineReplacements = /vultr_instance\.this|terraform_data\.revision/;
  private readonly headBucket: HeadBucket;
  /** One attachment change per load balancer at a time: Vultr replaces the whole instance list. */
  private readonly lbQueue = new Map<string, Promise<unknown>>();

  constructor(opts: VultrAdapterOptions) {
    super(opts);
    this.headBucket = opts.headBucket ?? headBucketS3;
  }

  capabilities(_target: CloudTarget): CloudCapability[] {
    return VULTR_CAPABILITIES;
  }

  protected configChecks(target: CloudTarget): TargetValidationCheck[] {
    return vultrConfigChecks(target);
  }

  protected credentials(ctx: ProviderContext): Promise<VultrCredentials> {
    return readCredentialFields<VultrCredentials>('vultr', ctx, this.opts.resolveSecret, { required: ['apiKey', 'stateAccessKeyId', 'stateSecretAccessKey'] });
  }

  protected api(ctx: ProviderContext, creds: VultrCredentials): VultrApi {
    return new VultrApi(creds.apiKey, this.fetch, ctx.signal);
  }

  protected async verifyIdentity(ctx: ProviderContext, creds: VultrCredentials): Promise<{ check: TargetValidationCheck; identity?: string }> {
    try {
      const r = await this.api(ctx, creds).get<{ account: { name?: string } }>('/account');
      const name = r?.account.name;
      return { check: { name: 'Account access', status: 'ok', message: 'Vultr accepted the API key.' }, identity: name || undefined };
    } catch (err) {
      const status = statusOf(err);
      const message =
        status === 401 || status === 403
          ? `Vultr rejected the API key (HTTP ${status}). Check the key and its access control list of allowed IP addresses.`
          : (err as Error).message;
      return { check: { name: 'Account access', status: 'error', message } };
    }
  }

  protected stateStore(ctx: ProviderContext, creds: VultrCredentials): StateStore {
    const cfg = vultrConfig(ctx.target);
    return new S3CompatibleStateStore({
      endpoint: stateEndpointUrl(cfg),
      region: STATE_SIGNING_REGION,
      bucket: cfg.stateBucket,
      accessKeyId: creds.stateAccessKeyId,
      secretAccessKey: creds.stateSecretAccessKey,
      pathStyle: true,
    });
  }

  protected backend(ctx: ProviderContext, stateKey: string): Record<string, unknown> {
    const cfg = vultrConfig(ctx.target);
    // No lockfile: conditional writes are not confirmed on Vultr Object Storage, and the platform
    // already runs one operation per resource at a time.
    return s3CompatibleBackend({ endpoint: stateEndpointUrl(cfg), region: STATE_SIGNING_REGION, bucket: cfg.stateBucket, key: stateKey, lockfile: false, pathStyle: true });
  }

  protected rootParts(_ctx: ProviderContext, _req: ResourceRequest): RootParts {
    return vultrRootParts();
  }

  protected runnerEnv(_ctx: ProviderContext, creds: VultrCredentials): Record<string, string> {
    return { VULTR_API_KEY: creds.apiKey, ...s3BackendEnv(creds.stateAccessKeyId, creds.stateSecretAccessKey) };
  }

  protected moduleCall(ctx: ProviderContext, req: ResourceRequest): ModuleCall {
    return vultrModuleCall(ctx, req);
  }

  protected async health(ctx: ProviderContext, creds: VultrCredentials, res: ResourceIdentifier, outputs: ResourceOutputs): Promise<HealthResult> {
    return checkVultrHealth(this.api(ctx, creds), res.serviceKind, outputs, { fetch: this.fetch, signal: ctx.signal, headBucket: this.headBucket });
  }

  protected override probe(ctx: ProviderContext, creds: VultrCredentials, res: ResourceIdentifier, outputs: ResourceOutputs): Promise<boolean | undefined> {
    return probeVultrExists(this.api(ctx, creds), res.serviceKind, outputs);
  }

  // ───────────────────────── lifecycle ─────────────────────────

  override async ensureResource(ctx: ProviderContext, req: ResourceRequest): Promise<ResourceResult> {
    const resolved = await this.resolveRequest(ctx, req);
    const previous = req.capability === 'instance-docker' ? await this.recordedOutputs(ctx, req) : undefined;
    const result = await super.ensureResource(ctx, resolved);
    if (req.capability === 'instance-docker') await this.syncAttachment(ctx, previous, result.outputs);
    return result;
  }

  override async planResource(ctx: ProviderContext, req: ResourceRequest): Promise<ResourcePlan> {
    return super.planResource(ctx, await this.resolveRequest(ctx, req));
  }

  override async detectDrift(ctx: ProviderContext, req: ResourceRequest): Promise<DriftChange[]> {
    return super.detectDrift(ctx, await this.resolveRequest(ctx, req));
  }

  override async deleteResource(ctx: ProviderContext, res: ResourceIdentifier): Promise<void> {
    if (res.capability === 'instance-docker') {
      const outputs = await this.knownOutputs(ctx, res);
      if (outputs) await this.syncAttachment(ctx, outputs, undefined);
    }
    await super.deleteResource(ctx, res);
  }

  /**
   * Looks up what the modules need from the Vultr catalog: the managed database plan for a size
   * and node count, and the Object Storage cluster and tier for the region. Choices already
   * recorded in state are kept while the size is unchanged, so a new plan in the catalog never
   * resizes or (for storage) replaces a running resource.
   */
  protected async resolveRequest(ctx: ProviderContext, req: ResourceRequest): Promise<ResourceRequest> {
    const spec = req.spec;
    const ov = overridesOf(spec);
    let resolved: VultrResolved | undefined;
    if (req.capability === 'managed-postgres' || req.capability === 'managed-valkey') {
      const size = String(spec.size ?? (req.capability === 'managed-valkey' ? 'micro' : 'small'));
      const nodes = databaseNodes(req.serviceKind, spec);
      const key = sizeKey(size, nodes);
      const recorded = ov.plan ? undefined : await this.recordedOutputs(ctx, req);
      const plan = ov.plan ?? (recorded?.size_key === key && recorded.plan ? String(recorded.plan) : await this.databasePlan(ctx, req.capability === 'managed-postgres' ? 'pg' : 'valkey', size, nodes));
      resolved = { plan, sizeKey: key };
    } else if (req.capability === 'object-storage') {
      if (ov.clusterId && ov.tierId) resolved = { clusterId: ov.clusterId, tierId: ov.tierId };
      else {
        const recorded = await this.recordedOutputs(ctx, req);
        resolved = recorded?.cluster_id && recorded.tier_id ? { clusterId: Number(recorded.cluster_id), tierId: Number(recorded.tier_id) } : await this.objectStorageLocation(ctx);
      }
    }
    return resolved ? { ...req, spec: { ...spec, vultrResolved: resolved } } : req;
  }

  private async databasePlan(ctx: ProviderContext, engine: 'pg' | 'valkey', size: string, nodes: number): Promise<string> {
    const api = this.api(ctx, await this.credentials(ctx));
    const r = await api.get<{ plans: VultrDatabasePlan[] }>(`/databases/plans?engine=${engine}&region=${ctx.region}`);
    const plan = pickDatabasePlan(r?.plans ?? [], engine, ctx.region, SIZE_RAM_MB[size] ?? 1024, nodes);
    if (!plan) {
      throw new ProviderError('VULTR_NO_DATABASE_PLAN', `Vultr offers no ${engine} plan with ${nodes} node(s) and size ${size} in ${ctx.region}. Pick another size or region, or set providerOverrides.vultr.plan.`, 'VALIDATION_ERROR', 'vultr');
    }
    return plan.id;
  }

  private async objectStorageLocation(ctx: ProviderContext): Promise<VultrResolved> {
    const api = this.api(ctx, await this.credentials(ctx));
    const clusters = (await api.get<{ clusters: VultrObjectStorageCluster[] }>('/object-storage/clusters'))?.clusters ?? [];
    const tiers = new Map<number, VultrObjectStorageTier[]>();
    for (const c of clusters.filter((x) => x.region === ctx.region && x.deploy === 'yes')) {
      tiers.set(c.id, (await api.get<{ tiers: VultrObjectStorageTier[] }>(`/object-storage/clusters/${c.id}/tiers`))?.tiers ?? []);
    }
    const pick = pickObjectStorage(clusters, tiers, ctx.region);
    if (!pick) throw new ProviderError('VULTR_NO_OBJECT_STORAGE', `Vultr Object Storage is not offered in ${ctx.region}. Choose another region.`, 'VALIDATION_ERROR', 'vultr');
    ctx.log?.('info', `Object Storage on ${pick.hostname}.`);
    return { clusterId: pick.clusterId, tierId: pick.tierId };
  }

  private async recordedOutputs(ctx: ProviderContext, req: ResourceRequest): Promise<ResourceOutputs | undefined> {
    const state = await this.getResource(ctx, { resourceId: req.resourceId, serviceKind: req.serviceKind, capability: req.capability, name: req.name });
    return state.exists ? state.outputs : undefined;
  }

  /**
   * Keeps the ingress load balancer's instance list in step with the service: removes the
   * instances recorded before the apply, adds the current ones, and leaves other entries alone.
   */
  private async syncAttachment(ctx: ProviderContext, before: ResourceOutputs | undefined, after: ResourceOutputs | undefined): Promise<void> {
    const oldLb = String(before?.lb_id ?? '');
    const newLb = String(after?.lb_id ?? '');
    const oldIds = csv(before?.instance_ids);
    const newIds = csv(after?.instance_ids);
    if (!oldLb && !newLb) return;
    const api = this.api(ctx, await this.credentials(ctx));
    if (oldLb && oldLb !== newLb) await this.updateMembers(api, oldLb, oldIds, [], true);
    if (newLb) await this.updateMembers(api, newLb, oldLb === newLb ? oldIds : [], newIds, false);
  }

  private updateMembers(api: VultrApi, lbId: string, remove: string[], add: string[], missingOk: boolean): Promise<void> {
    const run = async () => {
      const r = await api.get<{ load_balancer: VultrLoadBalancer }>(`/load-balancers/${lbId}`, missingOk);
      if (!r) return;
      const current = r.load_balancer.instances ?? [];
      const desired = [...new Set([...current.filter((id) => !remove.includes(id)), ...add])];
      if (desired.length === current.length && desired.every((id) => current.includes(id))) return;
      await api.send('PATCH', `/load-balancers/${lbId}`, { instances: desired });
    };
    const previous = this.lbQueue.get(lbId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(run);
    this.lbQueue.set(lbId, next);
    return next;
  }

  // ───────────────────────── secrets and actions ─────────────────────────

  async readSecret(ctx: ProviderContext, ref: string): Promise<Record<string, string>> {
    const api = this.api(ctx, await this.credentials(ctx));
    if (ref.startsWith(DB_REF)) {
      const r = await api.get<{ database: VultrDatabase }>(`/databases/${encodeURIComponent(ref.slice(DB_REF.length))}`);
      const db = r!.database;
      const host = db.public_host || db.host;
      const auth = `${encodeURIComponent(db.user)}:${encodeURIComponent(db.password)}`;
      const pg = db.database_engine === 'pg';
      const url = pg ? `postgresql://${auth}@${host}:${db.port}/${db.dbname ?? 'defaultdb'}?sslmode=require` : `rediss://${auth}@${host}:${db.port}`;
      return { url, host, port: String(db.port), username: db.user, password: db.password, ...(pg && db.dbname ? { database: db.dbname } : {}) };
    }
    if (ref.startsWith(OBJSTORE_REF)) {
      const r = await api.get<{ object_storage: VultrObjectStorage }>(`/object-storage/${encodeURIComponent(ref.slice(OBJSTORE_REF.length))}`);
      const s = r!.object_storage;
      return { endpoint: `https://${s.s3_hostname}`, accessKeyId: s.s3_access_key, secretAccessKey: s.s3_secret_key };
    }
    throw new ProviderError('VULTR_SECRET_REF_UNKNOWN', 'This secret reference was not published by the Vultr adapter.', 'VALIDATION_ERROR', 'vultr');
  }

  actions(capability: string): ResourceActionDescriptor[] {
    return capability === 'instance-docker' ? [RESTART] : [];
  }

  async runAction(ctx: ProviderContext, res: ResourceIdentifier, request: ResourceActionRequest): Promise<ResourceActionResult> {
    if (res.capability !== 'instance-docker' || request.action !== 'restart') {
      throw new ProviderError('VULTR_ACTION_UNSUPPORTED', `${request.action} is not available for ${res.capability}.`, 'VALIDATION_ERROR', 'vultr');
    }
    const outputs = await this.knownOutputs(ctx, res);
    const ids = csv(outputs?.instance_ids);
    if (!ids.length) return { status: 'completed', message: 'The service has no instances to restart.' };
    await this.api(ctx, await this.credentials(ctx)).send('POST', '/instances/reboot', { instance_ids: ids });
    return { status: 'started', message: `Rebooting ${ids.length} instance(s).` };
  }
}
