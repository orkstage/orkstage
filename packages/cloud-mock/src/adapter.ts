// SPDX-License-Identifier: AGPL-3.0-only
import {
  ProviderError,
  type CloudCapability,
  type CloudProviderAdapter,
  type CloudTarget,
  type HealthResult,
  type LogLine,
  type MetricPoint,
  type ProviderContext,
  type ResourceActionDescriptor,
  type ResourceActionRequest,
  type ResourceActionResult,
  type ResourceIdentifier,
  type ResourceOutputs,
  type ResourcePlan,
  type ResourceRequest,
  type ResourceResult,
  type ResourceState,
  type TargetValidationResult,
} from '@orkstage/cloud-core';
import { sha256, type FailureClass, type HealthState } from '@orkstage/domain';
import { SIMULATED_CATALOGS, type SimulatedProvider } from './catalogs.js';
import type { MockStateStore } from './store.js';

/**
 * Failure injection for one resource. `times` limits how many attempts fail, which makes
 * retry behaviour testable (e.g. a rate limit that clears after one retry).
 */
export interface InjectedFailure {
  failureClass: FailureClass;
  message?: string;
  times?: number;
}

/** Simulation settings, stored as the mock target's non-secret config. */
export interface MockTargetConfig {
  /** Which real provider this target imitates (catalog, naming, outputs). Default `aws`. */
  simulate?: SimulatedProvider;
  /** Seed for deterministic ids, latencies and telemetry. */
  seed?: string;
  latencyMs?: { min: number; max: number };
  failures?: Record<string, InjectedFailure>;
  /** Resource ids that report UNHEALTHY. Runtime overrides live in the state store. */
  unhealthy?: string[];
  /** Fail target validation, to exercise the connection-health flow. */
  invalidCredentials?: boolean;
  /** Resource ids whose changes plan as replacements (to exercise destructive-change approval). */
  destructivePlans?: string[];
}

interface StoredResource {
  providerResourceId: string;
  idempotencyKey: string;
  outputs: ResourceOutputs;
  createdAt: string;
}

export interface MockAdapterOptions {
  /** Sleep implementation; tests pass a no-op to run instantly. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new ProviderError('CANCELLED', 'Operation cancelled.', 'UNKNOWN', 'mock'));
    });
  });

/**
 * Deterministic simulation provider (spec §46). Every response is derived from the target
 * seed and resource identity, so the same inputs always produce the same ids, endpoints and
 * telemetry. It never contacts a real cloud and is always labelled as simulated.
 */
export class MockAdapter implements CloudProviderAdapter {
  readonly provider = 'mock' as const;
  readonly simulated = true;
  private readonly sleep: NonNullable<MockAdapterOptions['sleep']>;

  constructor(
    private readonly store: MockStateStore,
    options: MockAdapterOptions = {},
  ) {
    this.sleep = options.sleep ?? defaultSleep;
  }

  capabilities(target: CloudTarget): CloudCapability[] {
    return SIMULATED_CATALOGS[simulated(target)];
  }

  async validateTarget(ctx: ProviderContext): Promise<TargetValidationResult> {
    const cfg = config(ctx.target);
    const simulate = simulated(ctx.target);
    const regionOk = ctx.target.allowedRegions.includes(ctx.region);
    const checks = [
      cfg.invalidCredentials
        ? { name: 'Credentials', status: 'error' as const, message: 'Simulated credential failure (invalidCredentials is set).' }
        : { name: 'Credentials', status: 'ok' as const, message: `Simulated ${simulate} credentials accepted.` },
      regionOk
        ? { name: 'Region', status: 'ok' as const, message: `${ctx.region} available.` }
        : { name: 'Region', status: 'error' as const, message: `${ctx.region} is not allowed for this target.` },
      ...[...new Set(SIMULATED_CATALOGS[simulate].map((c) => c.displayName))].map((name) => ({
        name: `${name} permission`,
        status: 'ok' as const,
        message: 'Simulated permission granted.',
      })),
    ];
    return {
      ok: checks.every((c) => c.status === 'ok'),
      checks,
      validatedAt: new Date().toISOString(),
      identity: `simulated-${simulate}-${hash(ctx.target.id).slice(0, 12)}`,
    };
  }

  async ensureResource(ctx: ProviderContext, req: ResourceRequest): Promise<ResourceResult> {
    const key = this.key(ctx, req.name);
    const existing = await this.read(key);
    if (existing && existing.idempotencyKey === req.idempotencyKey) {
      return { providerResourceId: existing.providerResourceId, outputs: existing.outputs, unchanged: true };
    }

    await this.simulateLatency(ctx, req.resourceId);
    await this.maybeFail(ctx, req.resourceId, req.name);

    const cfg = config(ctx.target);
    const simulate = cfg.simulate ?? 'aws';
    const providerResourceId =
      existing?.providerResourceId ?? `sim-${simulate}-${req.serviceKind.split('.')[0]}-${hash(`${ctx.target.id}:${ctx.region}:${req.name}`).slice(0, 10)}`;
    const stored: StoredResource = {
      providerResourceId,
      idempotencyKey: req.idempotencyKey,
      outputs: outputsFor(req, ctx.region, simulate, providerResourceId),
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };
    await this.store.set(key, JSON.stringify(stored));
    return { providerResourceId, outputs: stored.outputs, unchanged: false };
  }

  async planResource(ctx: ProviderContext, req: ResourceRequest): Promise<ResourcePlan> {
    const existing = await this.read(this.key(ctx, req.name));
    const address = `mock_${req.serviceKind.replace(/\W/g, '_')}.${req.resourceId}`;
    if (!existing) return { changes: { add: 1, change: 0, remove: 0 }, actions: [{ address, action: 'create' }], destructive: false };
    if (existing.idempotencyKey === req.idempotencyKey) return { changes: { add: 0, change: 0, remove: 0 }, actions: [], destructive: false };
    const replace = config(ctx.target).destructivePlans?.includes(req.resourceId) ?? false;
    return replace
      ? { changes: { add: 1, change: 0, remove: 1 }, actions: [{ address, action: 'replace' }], destructive: true }
      : { changes: { add: 0, change: 1, remove: 0 }, actions: [{ address, action: 'update' }], destructive: false };
  }

  async deleteResource(ctx: ProviderContext, res: ResourceIdentifier): Promise<void> {
    const key = this.key(ctx, res.name);
    if (!(await this.read(key))) return;
    await this.simulateLatency(ctx, res.resourceId);
    await this.store.delete(key);
    await this.store.delete(this.healthKey(ctx, res.name));
  }

  async getResource(ctx: ProviderContext, res: ResourceIdentifier): Promise<ResourceState> {
    const stored = await this.read(this.key(ctx, res.name));
    if (!stored) return { exists: false, outputs: {} };
    const drift = await this.store.get(this.driftKey(ctx, res.name));
    return {
      exists: true,
      providerResourceId: stored.providerResourceId,
      outputs: stored.outputs,
      observedSpecHash: drift ?? stored.idempotencyKey,
    };
  }

  async checkHealth(ctx: ProviderContext, res: ResourceIdentifier): Promise<HealthResult> {
    const checkedAt = new Date().toISOString();
    if (!(await this.read(this.key(ctx, res.name)))) {
      return { state: 'UNHEALTHY', message: 'Resource does not exist.', checkedAt };
    }
    const override = (await this.store.get(this.healthKey(ctx, res.name))) as HealthState | null;
    const cfgUnhealthy = config(ctx.target).unhealthy?.includes(res.resourceId);
    const state: HealthState = override ?? (cfgUnhealthy ? 'UNHEALTHY' : 'HEALTHY');
    const latencyMs = 20 + (parseInt(hash(`${res.resourceId}:${checkedAt.slice(0, 16)}`).slice(0, 4), 16) % 60);
    return {
      state,
      latencyMs,
      message: state === 'HEALTHY' ? 'Simulated health check passed.' : 'Simulated health check failed.',
      checkedAt,
    };
  }

  /** The actions real platforms offer, simulated, so templates with triggers work without accounts. */
  actions(): ResourceActionDescriptor[] {
    return SIMULATED_ACTIONS;
  }

  async runAction(ctx: ProviderContext, res: ResourceIdentifier, request: ResourceActionRequest): Promise<ResourceActionResult> {
    await this.simulateLatency(ctx, res.resourceId);
    const state = await this.getResource(ctx, res);
    if (!state.exists) throw new ProviderError('SIM_NOT_FOUND', `${res.resourceId} does not exist (simulated).`, 'VALIDATION_ERROR', 'mock');
    const reference = `sim-${request.action}-${hash(`${res.name}:${ctx.correlationId}`).slice(0, 10)}`;
    const params = Object.entries(request.params).map(([k, v]) => `${k}=${String(v)}`).join(', ');
    return { reference, status: 'started', message: `Simulated ${request.action} of ${res.resourceId}${params ? ` (${params})` : ''}.` };
  }

  async getLogs(ctx: ProviderContext, res: ResourceIdentifier, limit: number): Promise<LogLine[]> {
    const now = Date.now();
    const lines: LogLine[] = [];
    for (let i = limit - 1; i >= 0; i--) {
      const n = parseInt(hash(`${ctx.target.id}:${res.resourceId}:${Math.floor(now / 10000) - i}`).slice(0, 4), 16);
      lines.push({
        timestamp: new Date(now - i * 10000).toISOString(),
        level: n % 23 === 0 ? 'warn' : 'info',
        message: n % 23 === 0 ? 'slow request detected (simulated)' : `GET /health 200 ${(n % 40) + 3}ms (simulated)`,
        attributes: { resource: res.resourceId, simulated: 'true' },
      });
    }
    return lines;
  }

  async getMetric(ctx: ProviderContext, res: ResourceIdentifier, metric: string, minutes: number): Promise<MetricPoint[]> {
    const now = Math.floor(Date.now() / 60000) * 60000;
    return Array.from({ length: minutes }, (_, i) => {
      const t = now - (minutes - 1 - i) * 60000;
      const n = parseInt(hash(`${ctx.target.id}:${res.resourceId}:${metric}:${t}`).slice(0, 4), 16) / 0xffff;
      return { timestamp: new Date(t).toISOString(), value: Math.round((20 + n * 40) * 10) / 10 };
    });
  }

  /** Simulation control: force a health state for a resource (used to exercise incidents). */
  async setHealthOverride(ctx: ProviderContext, name: string, state: HealthState | null): Promise<void> {
    if (state) await this.store.set(this.healthKey(ctx, name), state);
    else await this.store.delete(this.healthKey(ctx, name));
  }

  /** Simulation control: make a resource report a different observed spec (drift). */
  async simulateDrift(ctx: ProviderContext, name: string, drifted: boolean): Promise<void> {
    if (drifted) await this.store.set(this.driftKey(ctx, name), `drift-${Date.now()}`);
    else await this.store.delete(this.driftKey(ctx, name));
  }

  private key(ctx: ProviderContext, name: string) {
    // Physical names are unique per tenant and instance, like real cloud resource names.
    return `mock:${ctx.target.id}:${ctx.region}:res:${name}`;
  }
  private healthKey(ctx: ProviderContext, name: string) {
    // Physical names are unique per tenant and instance, like real cloud resource names.
    return `mock:${ctx.target.id}:${ctx.region}:health:${name}`;
  }
  private driftKey(ctx: ProviderContext, name: string) {
    // Physical names are unique per tenant and instance, like real cloud resource names.
    return `mock:${ctx.target.id}:${ctx.region}:drift:${name}`;
  }

  private async read(key: string): Promise<StoredResource | null> {
    const raw = await this.store.get(key);
    return raw ? (JSON.parse(raw) as StoredResource) : null;
  }

  private async simulateLatency(ctx: ProviderContext, resourceId: string) {
    const { min, max } = config(ctx.target).latencyMs ?? { min: 400, max: 1600 };
    const n = parseInt(hash(`${config(ctx.target).seed ?? ''}:${resourceId}`).slice(0, 6), 16) / 0xffffff;
    await this.sleep(Math.round(min + n * (max - min)), ctx.signal);
  }

  private async maybeFail(ctx: ProviderContext, resourceId: string, name: string) {
    const failure = config(ctx.target).failures?.[resourceId];
    if (!failure) return;
    const counterKey = `mock:${ctx.target.id}:${ctx.region}:failcount:${name}`;
    const count = Number((await this.store.get(counterKey)) ?? '0');
    if (failure.times !== undefined && count >= failure.times) return;
    await this.store.set(counterKey, String(count + 1));
    throw new ProviderError(
      'SIMULATED_FAILURE',
      failure.message ?? `Simulated ${failure.failureClass} while provisioning ${resourceId}.`,
      failure.failureClass,
      'mock',
      { resourceId, attempt: count + 1 },
    );
  }
}

function config(target: CloudTarget): MockTargetConfig {
  return target.config as MockTargetConfig;
}

function hash(value: string): string {
  return sha256(value);
}

const SIMULATED_ACTIONS: ResourceActionDescriptor[] = [
  {
    name: 'redeploy',
    description: 'Start a new rollout (simulated).',
    params: [
      { name: 'ref', type: 'string', description: 'Branch or commit.' },
      { name: 'target', type: 'string', description: 'production or preview.' },
      { name: 'clearCache', type: 'boolean' },
    ],
  },
  { name: 'restart', description: 'Restart running instances (simulated).', params: [] },
  { name: 'backup', description: 'Take an on demand backup (simulated).', params: [] },
];

/** The imitated provider; unknown values fall back to AWS instead of breaking the target. */
function simulated(target: CloudTarget): SimulatedProvider {
  const value = config(target).simulate;
  return value && value in SIMULATED_CATALOGS ? value : 'aws';
}

function outputsFor(req: ResourceRequest, region: string, simulate: string, id: string): ResourceOutputs {
  const short = id.slice(-10);
  const domain = `${simulate}.sim.internal`;
  switch (req.serviceKind) {
    case 'network':
      return { networkId: `net-${short}`, privateSubnets: 2, publicSubnets: 2 };
    case 'container-registry':
      return { repositoryUri: `registry.${region}.${domain}/${req.name}` };
    case 'compute.container-service':
      return { serviceId: id, internalEndpoint: `http://${req.name}.svc.${domain}:${req.spec.port ?? 8080}` };
    case 'database.postgresql':
      return { host: `${req.name}.pg.${region}.${domain}`, port: 5432, secretRef: `secret://${req.name}/credentials` };
    case 'cache.redis':
      return { host: `${req.name}.redis.${region}.${domain}`, port: 6379 };
    case 'queue':
      return { queueUrl: `https://queue.${region}.${domain}/${req.name}` };
    case 'object-storage':
      return { bucket: req.name, endpoint: `https://${req.name}.objects.${region}.${domain}` };
    case 'ingress':
      return { dnsName: `${req.name}.lb.${region}.${domain}` };
    case 'dns':
      return { fqdn: `${String(req.spec.subdomainLabel ?? req.name)}.platform.example.test`, tls: 'issued' };
    case 'web.frontend':
      return { url: `https://${req.name}.web.${domain}`, project_id: id };
    default:
      return {};
  }
}
