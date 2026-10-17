// SPDX-License-Identifier: AGPL-3.0-only
import {
  savedPlanFor,
  ProviderError,
  type CloudCapability,
  type CloudProviderAdapter,
  type CloudTarget,
  type DriftChange,
  type HealthResult,
  type LogLine,
  type ProviderContext,
  type ResourceIdentifier,
  type ResourceOutputs,
  type ResourcePlan,
  type ResourceRequest,
  type ResourceResult,
  type ResourceState,
  type TargetValidationCheck,
  type TargetValidationResult,
  type ValidateTargetOptions,
  flattenOutputs,
  now,
  safeMessage,
  type SecretResolver,
} from '@orkstage/cloud-core';
import type { CloudProvider } from '@orkstage/domain';
import type { TofuRunner, TofuStack } from '@orkstage/iac';
import { isDestructivePlan, toProviderError } from './helpers.js';
import type { StateStore } from './state.js';

export interface OpenTofuAdapterOptions {
  /** Resolves the target's credentialRef (env://, aws-sm://) at the moment of use. */
  resolveSecret: SecretResolver;
  /** OpenTofu runner. Without it, the adapter can validate targets but not provision. */
  runner?: TofuRunner;
  /** HTTP client for provider APIs (tests pass a fake). */
  fetch?: typeof fetch;
}

/** The module that implements one capability, and its inputs. */
export interface ModuleCall {
  /** Directory under /modules/<provider>/, e.g. `container-service`. */
  module: string;
  inputs: Record<string, unknown>;
}

/** Provider specific parts of the root configuration. Never put secret values here. */
export interface RootParts {
  requiredProviders: Record<string, { source: string; version: string }>;
  /** `provider` blocks keyed by provider name. */
  providers: Record<string, unknown>;
  /**
   * Root variables the provider blocks read (`var.<name>`), filled from `TF_VAR_<name>` in the
   * runner environment. This is how a secret that has no native environment variable (an OCI
   * private key, a Magalu API key) reaches the provider without being written to disk.
   */
  variables?: Record<string, { type?: string; sensitive?: boolean }>;
}

export const stateKeyFor = (name: string) => `orkstage/${name}.tfstate`;
const configKeyFor = (name: string) => `${stateKeyFor(name)}.config.json`;
const virtualKeyFor = (name: string) => `${stateKeyFor(name)}.virtual.json`;

/**
 * Shared base for providers provisioned with OpenTofu (Azure, GCP, OCI, DigitalOcean, Vultr,
 * CoreWeave, Magalu Cloud). Same model as the AWS adapter: one isolated state per resource
 * (blast radius = one resource) kept in the customer's own storage, executed in a throwaway
 * runner container, credentials passed as environment variables for one command only. The exact
 * configuration applied is stored beside its state so destroy never depends on a newer template.
 *
 * A provider supplies its catalog, credentials, state store and backend block, provider blocks,
 * module inputs per capability, and health checks through its REST API.
 */
export abstract class OpenTofuAdapter<Creds> implements CloudProviderAdapter {
  abstract readonly provider: CloudProvider;
  readonly simulated = false;
  protected readonly runner?: TofuRunner;
  protected readonly fetch: typeof fetch;
  /** Replacements that are routine rollouts, not losses (e.g. a new task revision). */
  protected readonly routineReplacements?: RegExp;

  constructor(protected readonly opts: OpenTofuAdapterOptions) {
    this.runner = opts.runner;
    this.fetch = opts.fetch ?? fetch;
  }

  abstract capabilities(target: CloudTarget): CloudCapability[];

  /** Checks of the target configuration that need no network (ids, formats). */
  protected abstract configChecks(target: CloudTarget): TargetValidationCheck[];
  /** Resolves and parses the target credentials. */
  protected abstract credentials(ctx: ProviderContext): Promise<Creds>;
  /** Calls the provider to prove the credentials work and reports who they belong to. */
  protected abstract verifyIdentity(ctx: ProviderContext, creds: Creds): Promise<{ check: TargetValidationCheck; identity?: string }>;
  protected abstract stateStore(ctx: ProviderContext, creds: Creds): StateStore;
  /** The `backend` block, e.g. `{ azurerm: { ... } }`, for one state key. */
  protected abstract backend(ctx: ProviderContext, stateKey: string): Record<string, unknown>;
  protected abstract rootParts(ctx: ProviderContext, req: ResourceRequest): RootParts;
  /** Credentials for the provider and the backend, as environment variables for the runner. */
  protected abstract runnerEnv(ctx: ProviderContext, creds: Creds): Record<string, string>;
  /** Module and inputs for a capability; throws a VALIDATION_ERROR ProviderError when unsupported. */
  protected abstract moduleCall(ctx: ProviderContext, req: ResourceRequest): ModuleCall;
  protected abstract health(ctx: ProviderContext, creds: Creds, res: ResourceIdentifier, outputs: ResourceOutputs): Promise<HealthResult>;

  /** Provider API existence check; `false` only when the provider says it is gone. */
  protected probe?(ctx: ProviderContext, creds: Creds, res: ResourceIdentifier, outputs: ResourceOutputs): Promise<boolean | undefined>;
  protected logs?(ctx: ProviderContext, creds: Creds, res: ResourceIdentifier, outputs: ResourceOutputs, limit: number): Promise<LogLine[]>;
  /** Extra validation after identity (permissions, quotas). Gaps for `opts.serviceKinds` should fail. */
  protected extraChecks?(ctx: ProviderContext, creds: Creds, opts: ValidateTargetOptions): Promise<TargetValidationCheck[]>;
  /**
   * Capabilities that need no infrastructure of their own (e.g. built-in ingress of a container
   * platform): return their outputs here and no OpenTofu run happens.
   */
  protected virtualResource?(ctx: ProviderContext, req: ResourceRequest): ResourceOutputs | undefined;

  /** Provider resource id from module outputs (the first of these keys that is set). */
  protected providerIdFrom(serviceKind: string, outputs: ResourceOutputs): string {
    const key = ['id', 'resource_id', 'service_id', 'app_id', 'cluster_id', 'network_id', 'bucket', 'url'].find((k) => outputs[k] !== undefined && outputs[k] !== '');
    return String(key ? outputs[key] : serviceKind);
  }

  // ───────────────────────── contract ─────────────────────────

  async validateTarget(ctx: ProviderContext, opts: ValidateTargetOptions = {}): Promise<TargetValidationResult> {
    const validatedAt = now();
    const checks = [...this.configChecks(ctx.target)];
    if (!ctx.target.allowedRegions.includes(ctx.region)) {
      checks.push({ name: 'Region', status: 'error', message: `${ctx.region} is not allowed for this target.` });
    }
    if (checks.some((c) => c.status === 'error')) return { ok: false, checks, validatedAt };

    let identity: string | undefined;
    try {
      const creds = await this.credentials(ctx);
      const who = await this.verifyIdentity(ctx, creds);
      checks.push(who.check);
      identity = who.identity;
      if (who.check.status === 'ok') {
        const store = this.stateStore(ctx, creds);
        try {
          await store.check(ctx.signal);
          checks.push({ name: 'State storage', status: 'ok', message: `OpenTofu state in ${store.location}.` });
        } catch (err) {
          checks.push({ name: 'State storage', status: 'missing', message: `${store.location} is not accessible (${safeMessage(err)}). Create it before deploying.` });
        }
        if (this.extraChecks) checks.push(...(await this.extraChecks(ctx, creds, opts)));
      }
    } catch (err) {
      checks.push({ name: 'Credentials', status: 'error', message: err instanceof ProviderError ? err.message : safeMessage(err) });
    }

    checks.push(
      this.runner
        ? { name: 'Provisioning runner', status: 'ok', message: 'OpenTofu runner configured.' }
        : { name: 'Provisioning runner', status: 'skipped', message: 'No OpenTofu runner in this process (validation only).' },
    );
    return { ok: checks.every((c) => c.status !== 'error' && c.status !== 'missing'), checks, validatedAt, identity };
  }

  async ensureResource(ctx: ProviderContext, req: ResourceRequest): Promise<ResourceResult> {
    const creds = await this.credentials(ctx);
    const store = this.stateStore(ctx, creds);
    const virtual = this.virtualResource?.(ctx, req);
    if (virtual) {
      const previous = await store.get(virtualKeyFor(req.name), ctx.signal);
      const body = JSON.stringify(virtual);
      if (previous !== body) await store.put(virtualKeyFor(req.name), body, ctx.signal);
      return { providerResourceId: this.providerIdFrom(req.serviceKind, virtual), outputs: virtual, unchanged: previous === body };
    }

    const runner = this.requireRunner();
    const config = this.rootConfig(ctx, req);
    try {
      const result = await runner.apply(this.stack(ctx, creds, req.name, config, savedPlanFor(req)));
      // Keep the exact configuration beside its state so destroy never depends on a stale template.
      await store.put(configKeyFor(req.name), JSON.stringify(config), ctx.signal);
      const outputs = flattenOutputs(result.outputs.all);
      const unchanged = result.changes.add + result.changes.change + result.changes.remove === 0;
      return { providerResourceId: this.providerIdFrom(req.serviceKind, outputs), outputs, unchanged };
    } catch (err) {
      throw toProviderError(this.provider, err);
    }
  }

  async planResource(ctx: ProviderContext, req: ResourceRequest): Promise<ResourcePlan> {
    if (this.virtualResource?.(ctx, req)) return { changes: { add: 0, change: 0, remove: 0 }, actions: [], destructive: false };
    const runner = this.requireRunner();
    const creds = await this.credentials(ctx);
    try {
      const plan = await runner.plan(this.stack(ctx, creds, req.name, this.rootConfig(ctx, req), savedPlanFor(req)));
      return { ...plan, destructive: isDestructivePlan(plan.actions, this.routineReplacements) };
    } catch (err) {
      throw toProviderError(this.provider, err);
    }
  }

  async detectDrift(ctx: ProviderContext, req: ResourceRequest): Promise<DriftChange[]> {
    if (this.virtualResource?.(ctx, req)) return [];
    const runner = this.requireRunner();
    const creds = await this.credentials(ctx);
    try {
      return await runner.drift(this.stack(ctx, creds, req.name, this.rootConfig(ctx, req)));
    } catch (err) {
      throw toProviderError(this.provider, err);
    }
  }

  async deleteResource(ctx: ProviderContext, res: ResourceIdentifier): Promise<void> {
    const creds = await this.credentials(ctx);
    const store = this.stateStore(ctx, creds);
    if (await store.get(virtualKeyFor(res.name), ctx.signal)) {
      await store.delete(virtualKeyFor(res.name), ctx.signal);
      return;
    }
    const raw = await store.get(configKeyFor(res.name), ctx.signal);
    if (!raw) return; // never applied, or already destroyed: idempotent
    const runner = this.requireRunner();
    try {
      await runner.destroy(this.stack(ctx, creds, res.name, JSON.parse(raw) as Record<string, unknown>));
      await store.delete(configKeyFor(res.name), ctx.signal);
    } catch (err) {
      throw toProviderError(this.provider, err);
    }
  }

  async getResource(ctx: ProviderContext, res: ResourceIdentifier): Promise<ResourceState> {
    const store = this.stateStore(ctx, await this.credentials(ctx));
    const virtual = await store.get(virtualKeyFor(res.name), ctx.signal);
    if (virtual) return { exists: true, outputs: JSON.parse(virtual) as ResourceOutputs };
    const raw = await store.get(stateKeyFor(res.name), ctx.signal);
    if (!raw) return { exists: false, outputs: {} };
    const state = JSON.parse(raw) as { resources?: { mode: string }[]; outputs?: { all?: { value: unknown } } };
    const exists = (state.resources ?? []).some((r) => r.mode === 'managed');
    // observedSpecHash stays undefined: drift is checked with a refresh-only plan, not on every read.
    return { exists, outputs: exists ? flattenOutputs(state.outputs?.all?.value) : {} };
  }

  async checkHealth(ctx: ProviderContext, res: ResourceIdentifier): Promise<HealthResult> {
    try {
      const outputs = await this.knownOutputs(ctx, res);
      if (!outputs) return { state: 'UNHEALTHY', message: 'Resource does not exist (no managed state).', checkedAt: now() };
      return await this.health(ctx, await this.credentials(ctx), res, outputs);
    } catch (err) {
      return { state: 'UNHEALTHY', message: err instanceof ProviderError ? err.message : safeMessage(err), checkedAt: now() };
    }
  }

  async probeExists(ctx: ProviderContext, res: ResourceIdentifier): Promise<boolean | undefined> {
    const state = await this.getResource(ctx, res);
    if (!state.exists) return false;
    return this.probe ? this.probe(ctx, await this.credentials(ctx), res, state.outputs) : undefined;
  }

  async getLogs(ctx: ProviderContext, res: ResourceIdentifier, limit: number): Promise<LogLine[]> {
    if (!this.logs) return [];
    const outputs = await this.knownOutputs(ctx, res);
    return outputs ? this.logs(ctx, await this.credentials(ctx), res, outputs, limit) : [];
  }

  // ───────────────────────── configuration ─────────────────────────

  /** Complete root configuration (OpenTofu JSON syntax) for one resource's isolated state. */
  rootConfig(ctx: ProviderContext, req: ResourceRequest): Record<string, unknown> {
    const { module, inputs } = this.moduleCall(ctx, req);
    const parts = this.rootParts(ctx, req);
    return {
      terraform: {
        required_version: '>= 1.11',
        required_providers: parts.requiredProviders,
        backend: this.backend(ctx, stateKeyFor(req.name)),
      },
      ...(parts.variables && Object.keys(parts.variables).length ? { variable: parts.variables } : {}),
      provider: parts.providers,
      module: { resource: { source: `/modules/${this.provider}/${module}`, ...inputs } },
      output: { all: { value: '${module.resource}' } },
    };
  }

  protected requireRunner(): TofuRunner {
    if (!this.runner) {
      throw new ProviderError(`${this.provider.toUpperCase()}_RUNNER_NOT_CONFIGURED`, `No OpenTofu runner is configured in this process; ${this.provider} resources are provisioned by the worker.`, 'DEPLOYMENT_ERROR', this.provider);
    }
    return this.runner;
  }

  protected stack(ctx: ProviderContext, creds: Creds, name: string, config: Record<string, unknown>, savedPlan?: TofuStack['savedPlan']): TofuStack {
    return {
      stateKey: `${ctx.target.id}/${ctx.region}/${stateKeyFor(name)}`,
      config,
      savedPlan,
      env: this.runnerEnv(ctx, creds),
      signal: ctx.signal,
      onLog: (l) => ctx.log?.(l.level, l.message),
    };
  }

  /** Recorded outputs when the caller passed them, otherwise the outputs in state; null when absent. */
  protected async knownOutputs(ctx: ProviderContext, res: ResourceIdentifier): Promise<ResourceOutputs | null> {
    if (res.outputs && Object.keys(res.outputs).length) return res.outputs;
    const state = await this.getResource(ctx, res);
    return state.exists ? state.outputs : null;
  }
}
