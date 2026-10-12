// SPDX-License-Identifier: AGPL-3.0-only
import {
  failureClassForStatus,
  HttpError,
  ProviderError,
  readCredentialFields,
  safeMessage,
  secretEnvironment,
  TokenCache,
  type CloudCapability,
  type CloudTarget,
  type DriftChange,
  type HealthResult,
  type LogLine,
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
import { apiServerUrl, CLUSTER_RUNNING, coreweaveApi, findCluster, whoAmI, type CoreWeaveApi } from './api.js';
import { COREWEAVE_CAPABILITIES } from './catalog.js';
import { coreweaveConfig, coreweaveConfigChecks, DEFAULT_STATE_ENDPOINT, zoneFor, type CoreWeaveCredentials } from './config.js';
import { coreweaveHealth, coreweaveProbe, podLogs, restartDeployment, type HealthDeps } from './health.js';
import { kubeRequest, parseKubeconfig, type ClusterAccess } from './kube.js';
import { CLUSTER_KINDS, moduleCall, rootParts } from './stacks.js';

const RESTART: ResourceActionDescriptor = {
  name: 'restart',
  description: 'Rolling restart of every pod of the Deployment (kubectl rollout restart), keeping the same image and settings.',
  params: [],
};

/** Values one OpenTofu run needs beyond the target credentials: cluster access and dependency secrets. */
interface RunExtras {
  cluster?: ClusterAccess;
  secretEnv: Record<string, string>;
}

/**
 * CoreWeave adapter. VPCs and AI Object Storage buckets are created with the coreweave OpenTofu
 * provider; container services and ingress routes are Kubernetes objects on the target's
 * existing CKS cluster, created with the kubernetes provider. State lives in an AI Object
 * Storage bucket of the customer. Health, logs and restarts use the CoreWeave and Kubernetes
 * REST APIs with the same API access token (CKS managed auth accepts it as a bearer token).
 */
export class CoreWeaveAdapter extends OpenTofuAdapter<CoreWeaveCredentials> {
  readonly provider = 'coreweave' as const;
  private readonly clusters = new TokenCache();
  /** Per call extras, keyed by the call's context object (runnerEnv is synchronous). */
  private readonly runs = new WeakMap<ProviderContext, RunExtras>();

  constructor(opts: OpenTofuAdapterOptions) {
    super(opts);
  }

  capabilities(_target: CloudTarget): CloudCapability[] {
    return COREWEAVE_CAPABILITIES;
  }

  protected configChecks(target: CloudTarget): TargetValidationCheck[] {
    return coreweaveConfigChecks(target);
  }

  protected credentials(ctx: ProviderContext): Promise<CoreWeaveCredentials> {
    return readCredentialFields<CoreWeaveCredentials>('coreweave', ctx, this.opts.resolveSecret, { required: ['token', 'stateAccessKeyId', 'stateSecretAccessKey'] });
  }

  protected async verifyIdentity(ctx: ProviderContext, creds: CoreWeaveCredentials): Promise<{ check: TargetValidationCheck; identity?: string }> {
    try {
      const { orgUid } = await whoAmI(this.api(ctx, creds));
      return { check: { name: 'Organization access', status: 'ok', message: `Connected to CoreWeave organization ${orgUid}.` }, identity: orgUid };
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 0;
      const message = status === 401 ? 'CoreWeave rejected the API access token (expired or revoked).' : `Could not read the token identity: ${safeMessage(err)}`;
      return { check: { name: 'Organization access', status: 'error', message } };
    }
  }

  protected override async extraChecks(ctx: ProviderContext, creds: CoreWeaveCredentials, opts: ValidateTargetOptions): Promise<TargetValidationCheck[]> {
    const cfg = coreweaveConfig(ctx.target);
    const blocking = (opts.serviceKinds ?? []).some((k) => CLUSTER_KINDS.has(k));
    if (!creds.kubeconfig && !cfg.clusterName) {
      return [{ name: 'CKS cluster', status: blocking ? 'error' : 'warn', message: 'No clusterName or kubeconfig: container services and ingress cannot be deployed on this target.' }];
    }
    try {
      if (!creds.kubeconfig && cfg.clusterName) {
        const cluster = await findCluster(this.api(ctx, creds), cfg.clusterName, cfg.zone);
        if (cluster.status && cluster.status !== CLUSTER_RUNNING) {
          return [{ name: 'CKS cluster', status: blocking ? 'error' : 'warn', message: `CKS cluster ${cluster.name} is ${cluster.status}.` }];
        }
      }
      const access = await this.cluster(ctx, creds);
      await kubeRequest(this.fetch, access, '/version', { signal: ctx.signal });
      return [{ name: 'CKS cluster', status: 'ok', message: `Kubernetes API reachable at ${new URL(access.host).host}.` }];
    } catch (err) {
      const message = err instanceof ProviderError ? err.message : `Kubernetes API not reachable: ${safeMessage(err)}`;
      return [{ name: 'CKS cluster', status: blocking ? 'error' : 'warn', message }];
    }
  }

  protected stateStore(ctx: ProviderContext, creds: CoreWeaveCredentials): StateStore {
    const cfg = coreweaveConfig(ctx.target);
    return this.bucketStore(ctx, creds, cfg.stateBucket);
  }

  /** Virtual hosted style: AI Object Storage rejects path style requests. Locking is off (conditional writes not confirmed). */
  protected backend(ctx: ProviderContext, stateKey: string): Record<string, unknown> {
    const cfg = coreweaveConfig(ctx.target);
    return s3CompatibleBackend({ endpoint: cfg.stateEndpoint ?? DEFAULT_STATE_ENDPOINT, region: zoneFor(cfg, ctx.region), bucket: cfg.stateBucket, key: stateKey, pathStyle: false });
  }

  protected rootParts(ctx: ProviderContext, req: ResourceRequest): RootParts {
    return rootParts(ctx, req);
  }

  /**
   * COREWEAVE_API_TOKEN for the coreweave provider, the state keys for the backend, and for
   * cluster workloads the Kubernetes endpoint, token, CA and dependency secrets as TF_VAR_*.
   * Undeclared TF_VAR_* values are ignored by OpenTofu, so they are always set.
   */
  protected runnerEnv(ctx: ProviderContext, creds: CoreWeaveCredentials): Record<string, string> {
    const extras = this.runs.get(ctx);
    return {
      COREWEAVE_API_TOKEN: creds.token,
      ...s3BackendEnv(creds.stateAccessKeyId, creds.stateSecretAccessKey),
      TF_VAR_k8s_host: extras?.cluster?.host ?? '',
      TF_VAR_k8s_token: extras?.cluster?.token ?? '',
      TF_VAR_k8s_ca: extras?.cluster?.ca ?? '',
      TF_VAR_secret_env: JSON.stringify(extras?.secretEnv ?? {}),
    };
  }

  protected moduleCall(ctx: ProviderContext, req: ResourceRequest): ModuleCall {
    return moduleCall(ctx, req);
  }

  // OpenTofu runs of cluster workloads need the cluster connection (and dependency secrets)
  // resolved before the synchronous runnerEnv hook is called.

  override async ensureResource(ctx: ProviderContext, req: ResourceRequest): Promise<ResourceResult> {
    return this.withRun(ctx, req.serviceKind, req, () => super.ensureResource(ctx, req));
  }

  override async planResource(ctx: ProviderContext, req: ResourceRequest): Promise<ResourcePlan> {
    return this.withRun(ctx, req.serviceKind, req, () => super.planResource(ctx, req));
  }

  override async detectDrift(ctx: ProviderContext, req: ResourceRequest): Promise<DriftChange[]> {
    return this.withRun(ctx, req.serviceKind, req, () => super.detectDrift(ctx, req));
  }

  override async deleteResource(ctx: ProviderContext, res: ResourceIdentifier): Promise<void> {
    return this.withRun(ctx, res.serviceKind, undefined, () => super.deleteResource(ctx, res));
  }

  protected async health(ctx: ProviderContext, creds: CoreWeaveCredentials, res: ResourceIdentifier, outputs: ResourceOutputs): Promise<HealthResult> {
    return coreweaveHealth(res.serviceKind, outputs, this.healthDeps(ctx, creds));
  }

  protected override probe(ctx: ProviderContext, creds: CoreWeaveCredentials, res: ResourceIdentifier, outputs: ResourceOutputs): Promise<boolean | undefined> {
    return coreweaveProbe(res.serviceKind, outputs, this.healthDeps(ctx, creds));
  }

  protected override async logs(ctx: ProviderContext, creds: CoreWeaveCredentials, res: ResourceIdentifier, outputs: ResourceOutputs, limit: number): Promise<LogLine[]> {
    if (res.serviceKind !== 'compute.container-service' || !outputs.namespace) return [];
    return podLogs(this.fetch, await this.cluster(ctx, creds), outputs, limit, ctx.signal);
  }

  actions(capability: string): ResourceActionDescriptor[] {
    return capability === 'cks-deployment' ? [RESTART] : [];
  }

  async runAction(ctx: ProviderContext, res: ResourceIdentifier, request: ResourceActionRequest): Promise<ResourceActionResult> {
    if (request.action !== 'restart' || res.capability !== 'cks-deployment') {
      throw new ProviderError('COREWEAVE_ACTION_UNSUPPORTED', `${request.action} is not available for ${res.capability}.`, 'VALIDATION_ERROR', 'coreweave');
    }
    const outputs = await this.knownOutputs(ctx, res);
    if (!outputs?.deployment) throw new ProviderError('COREWEAVE_RESOURCE_MISSING', `${res.resourceId} has no Deployment yet.`, 'VALIDATION_ERROR', 'coreweave');
    try {
      const creds = await this.credentials(ctx);
      const at = await restartDeployment(this.fetch, await this.cluster(ctx, creds), outputs, ctx.signal);
      return { status: 'started', reference: at, message: 'Rolling restart started.', ...(outputs.url ? { url: String(outputs.url) } : {}) };
    } catch (err) {
      if (err instanceof HttpError) throw new ProviderError('COREWEAVE_RESTART_FAILED', err.message, failureClassForStatus(err.status), 'coreweave');
      throw err;
    }
  }

  // ───────────────────────── internals ─────────────────────────

  private api(ctx: ProviderContext, creds: CoreWeaveCredentials): CoreWeaveApi {
    return coreweaveApi(this.fetch, creds.token, ctx.signal);
  }

  private bucketStore(ctx: ProviderContext, creds: CoreWeaveCredentials, bucket: string): StateStore {
    const cfg = coreweaveConfig(ctx.target);
    return new S3CompatibleStateStore({
      endpoint: cfg.stateEndpoint ?? DEFAULT_STATE_ENDPOINT,
      region: zoneFor(cfg, ctx.region),
      bucket,
      accessKeyId: creds.stateAccessKeyId,
      secretAccessKey: creds.stateSecretAccessKey,
      pathStyle: false,
    });
  }

  private healthDeps(ctx: ProviderContext, creds: CoreWeaveCredentials): HealthDeps {
    return {
      fetch: this.fetch,
      api: this.api(ctx, creds),
      cluster: () => this.cluster(ctx, creds),
      bucket: (name) => this.bucketStore(ctx, creds, name),
      signal: ctx.signal,
    };
  }

  /**
   * Kubernetes API access for the target's cluster: the kubeconfig from the credential secret
   * when present, otherwise the named CKS cluster's endpoint with the API access token (CKS
   * managed auth accepts it, and the managed endpoint has a publicly trusted certificate).
   */
  protected async cluster(ctx: ProviderContext, creds: CoreWeaveCredentials): Promise<ClusterAccess> {
    if (creds.kubeconfig) {
      const kc = parseKubeconfig(creds.kubeconfig);
      return { host: kc.server, token: kc.token ?? creds.token, ca: kc.ca ?? '' };
    }
    const cfg = coreweaveConfig(ctx.target);
    if (!cfg.clusterName) {
      throw new ProviderError('COREWEAVE_CLUSTER_MISSING', 'Set clusterName in the target configuration (or a kubeconfig in the credential secret) to deploy container services and ingress on CoreWeave.', 'VALIDATION_ERROR', 'coreweave');
    }
    const name = cfg.clusterName;
    const host = await this.clusters.get(`${ctx.target.id}/${name}`, async () => {
      const cluster = await findCluster(this.api(ctx, creds), name, cfg.zone);
      return { value: apiServerUrl(cluster), expiresInSeconds: 900 };
    });
    return { host, token: creds.token, ca: '' };
  }

  private async withRun<T>(ctx: ProviderContext, kind: string, req: ResourceRequest | undefined, fn: () => Promise<T>): Promise<T> {
    if (!CLUSTER_KINDS.has(kind)) return fn();
    const creds = await this.credentials(ctx);
    const cluster = await this.cluster(ctx, creds);
    const secretEnv = req && kind === 'compute.container-service' ? await this.dependencySecrets(ctx, req) : {};
    this.runs.set(ctx, { cluster, secretEnv });
    try {
      return await fn();
    } finally {
      this.runs.delete(ctx);
    }
  }

  /**
   * Credentials of dependencies that publish a `secret_ref` (a database on another provider),
   * as `<ID>_PASSWORD`, `<ID>_URL` and so on. CoreWeave has no secret manager, so they become a
   * Kubernetes Secret in the service's namespace. Plans and drift checks run without them.
   */
  private async dependencySecrets(ctx: ProviderContext, req: ResourceRequest): Promise<Record<string, string>> {
    const ids = Object.entries(req.dependencyOutputs)
      .filter(([, out]) => typeof out.secret_ref === 'string' && out.secret_ref !== '')
      .map(([id]) => id);
    if (!ids.length) return {};
    if (!ctx.dependencySecret) {
      ctx.log?.('warn', `Credentials of ${ids.join(', ')} are not available in this call; the service secret is left empty.`);
      return {};
    }
    const env: Record<string, string> = {};
    for (const id of ids) Object.assign(env, secretEnvironment(id, await ctx.dependencySecret(id)));
    return env;
  }
}
