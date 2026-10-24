// SPDX-License-Identifier: AGPL-3.0-only
import {
  allowlistAddresses,
  ProviderError,
  secretEnvironment,
  type BackupInfo,
  type CertificateInfo,
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
  /** Container images that report UNHEALTHY while they run, to exercise automatic rollback. */
  unhealthyImages?: string[];
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
    const outputs = { ...outputsFor(req, ctx.region, simulate, providerResourceId), ...releaseOutputs(req, existing?.outputs) };
    // Like the real adapters: a service copies the credentials of a dependency on another
    // (simulated) provider into its own secret store. Only the names are kept, never the values.
    if (req.serviceKind === 'compute.container-service') {
      const foreign = Object.entries(req.dependencyOutputs).filter(([, o]) => typeof o.secret_ref === 'string' && o.provider !== simulate);
      if (foreign.length && ctx.dependencySecret) {
        const names: string[] = [];
        for (const [id] of foreign) names.push(...Object.keys(secretEnvironment(id, await ctx.dependencySecret(id))));
        outputs.external_secrets = names.sort().join(',');
      }
    }
    const stored: StoredResource = {
      providerResourceId,
      idempotencyKey: req.idempotencyKey,
      outputs,
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
    const image = String((await this.read(this.key(ctx, res.name)))?.outputs.image ?? '');
    const cfgUnhealthy = config(ctx.target).unhealthy?.includes(res.resourceId) || (image !== '' && (config(ctx.target).unhealthyImages ?? []).includes(image));
    const state: HealthState = override ?? (cfgUnhealthy ? 'UNHEALTHY' : 'HEALTHY');
    const latencyMs = 20 + (parseInt(hash(`${res.resourceId}:${checkedAt.slice(0, 16)}`).slice(0, 4), 16) % 60);
    return {
      state,
      latencyMs,
      message: state === 'HEALTHY' ? 'Simulated health check passed.' : 'Simulated health check failed.',
      checkedAt,
    };
  }

  /** Simulated credentials of a database: stable per reference, never a real secret. */
  async readSecret(_ctx: ProviderContext, ref: string): Promise<Record<string, string>> {
    if (!ref.startsWith('secret://')) throw new ProviderError('SIM_SECRET_UNKNOWN', `${ref} is not a simulated secret.`, 'VALIDATION_ERROR', 'mock');
    return { username: 'app', password: `sim-${hash(ref).slice(0, 16)}` };
  }

  /** Canary and blue/green releases of container services, simulated as traffic weights (ADR 0009). */
  releaseStrategies(capability: string): ('canary' | 'blueGreen')[] {
    const service = Object.values(SIMULATED_CATALOGS).some((list) => list.some((c) => c.capability === capability && c.serviceKind === 'compute.container-service'));
    return service ? ['canary', 'blueGreen'] : [];
  }

  async promoteRelease(ctx: ProviderContext, res: ResourceIdentifier): Promise<void> {
    const key = this.key(ctx, res.name);
    const stored = await this.read(key);
    if (!stored?.outputs.previous_image) return;
    const { previous_image: _old, release_strategy: _strategy, ...outputs } = stored.outputs;
    await this.store.set(key, JSON.stringify({ ...stored, outputs: { ...outputs, traffic_percent: 100 } }));
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
    const pinned = await this.store.get(this.metricKey(ctx, res.name, metric));
    return Array.from({ length: minutes }, (_, i) => {
      const t = now - (minutes - 1 - i) * 60000;
      if (pinned !== null && pinned !== undefined) return { timestamp: new Date(t).toISOString(), value: Number(pinned) };
      const n = parseInt(hash(`${ctx.target.id}:${res.resourceId}:${metric}:${t}`).slice(0, 4), 16) / 0xffff;
      return { timestamp: new Date(t).toISOString(), value: Math.round((20 + n * 40) * 10) / 10 };
    });
  }

  /**
   * Backups of a simulated database: one a day at 03:00 UTC, kept as long as the template says, a
   * point in time window over the retention, and a failure when a test pinned one.
   */
  async getBackups(_ctx: ProviderContext, res: ResourceIdentifier): Promise<BackupInfo | null> {
    if (res.serviceKind !== 'database.postgresql') return null;
    const retentionDays = Number(res.outputs?.backup_retention_days ?? 7);
    if (retentionDays <= 0) return { enabled: false };
    const now = Date.now();
    const today = new Date(now);
    today.setUTCHours(3, 0, 0, 0);
    const last = today.getTime() <= now ? today.getTime() : today.getTime() - 86_400_000;
    const failure = await this.store.get(`backup-failure:${res.name}`);
    return {
      enabled: true,
      retentionDays,
      lastBackupAt: new Date(failure ? last - 86_400_000 : last).toISOString(),
      nextBackupAt: new Date(last + 86_400_000).toISOString(),
      earliestRestorableAt: new Date(now - retentionDays * 86_400_000).toISOString(),
      latestRestorableAt: new Date(now - 5 * 60_000).toISOString(),
      ...(failure ? { lastFailure: { at: new Date(last).toISOString(), message: failure } } : {}),
    };
  }

  /** Simulation control: make the last backup of a database fail (null: back to normal). */
  async setBackupFailure(name: string, message: string | null): Promise<void> {
    if (message === null) await this.store.delete(`backup-failure:${name}`);
    else await this.store.set(`backup-failure:${name}`, message);
  }

  /**
   * Certificates of a simulated `dns` or `web.frontend` resource: issued, valid for 60 days from
   * now (as if renewed on time), unless a test pinned an expiry with `setCertificateExpiry`.
   */
  async getCertificates(_ctx: ProviderContext, res: ResourceIdentifier): Promise<CertificateInfo[]> {
    const out = (res.outputs ?? {}) as Record<string, unknown>;
    const list = (v: unknown) => (typeof v === 'string' && v ? v.split(',') : []);
    const hostnames =
      res.serviceKind === 'dns'
        ? [String(out.fqdn ?? ''), ...list(out.custom_domains)]
        : res.serviceKind === 'web.frontend'
          ? [String(out.url ?? '').replace(/^https?:\/\//, ''), ...list(out.domains)]
          : [];
    const certs: CertificateInfo[] = [];
    for (const hostname of hostnames.filter(Boolean)) {
      const pinned = await this.store.get(`cert:${hostname}`);
      const notAfter = pinned ?? new Date(Date.now() + 60 * 86_400_000).toISOString();
      certs.push({ hostname, status: Date.parse(notAfter) <= Date.now() ? 'EXPIRED' : 'ISSUED', notAfter });
    }
    return certs;
  }

  /** Simulation control: pin when the certificate of a hostname expires (null: back to renewed). */
  async setCertificateExpiry(hostname: string, notAfter: string | null): Promise<void> {
    if (notAfter === null) await this.store.delete(`cert:${hostname}`);
    else await this.store.set(`cert:${hostname}`, notAfter);
  }

  /** Simulated public DNS: records set with `setDnsRecord`, shared by every simulated target. */
  async lookupDns(_ctx: ProviderContext, name: string, type: 'TXT' | 'CNAME'): Promise<string[]> {
    const stored = await this.store.get(`dns:${type}:${name.toLowerCase()}`);
    return stored ? (JSON.parse(stored) as string[]) : [];
  }

  /** Simulation control: create (or with null, remove) a DNS record in the simulated public DNS. */
  async setDnsRecord(name: string, type: 'TXT' | 'CNAME', values: string[] | null): Promise<void> {
    const key = `dns:${type}:${name.toLowerCase()}`;
    if (values === null || values.length === 0) await this.store.delete(key);
    else await this.store.set(key, JSON.stringify(values));
  }

  /** Simulation control: pin a metric of a resource to a value (null: back to the series), for metric alerts. */
  async setMetricOverride(ctx: ProviderContext, name: string, metric: string, value: number | null): Promise<void> {
    if (value === null) await this.store.delete(this.metricKey(ctx, name, metric));
    else await this.store.set(this.metricKey(ctx, name, metric), String(value));
  }

  private metricKey(ctx: ProviderContext, name: string, metric: string) {
    return `${this.key(ctx, name)}:metric:${metric}`;
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
  { name: 'service.scale', description: 'Set the number of running instances (simulated).', params: [{ name: 'replicas', type: 'number', required: true, description: 'Instances to run.' }] },
  { name: 'database.reboot', description: 'Reboot the database server (simulated).', params: [] },
  { name: 'cdn.invalidate', description: 'Drop cached responses (simulated).', params: [] },
  { name: 'backup', description: 'Take an on demand backup (simulated).', params: [] },
  {
    name: 'restore',
    description: 'Restore the database to a point in time, as a new database (simulated).',
    params: [{ name: 'pointInTime', type: 'string', description: 'ISO time within the restore window; the latest restorable time when empty.' }],
  },
];

/** The imitated provider; unknown values fall back to AWS instead of breaking the target. */
function simulated(target: CloudTarget): SimulatedProvider {
  const value = config(target).simulate;
  return value && value in SIMULATED_CATALOGS ? value : 'aws';
}

/**
 * The image a container service runs and, during a canary or blue/green release, the share of
 * traffic the new release gets and the image it replaces. Any other apply ends a release in favour
 * of what it applies (that is how a rollback looks).
 */
function releaseOutputs(req: ResourceRequest, previous: ResourceOutputs | undefined): ResourceOutputs {
  if (req.serviceKind !== 'compute.container-service') return {};
  const image = String(req.spec.image ?? '');
  const before = previous?.image === undefined ? undefined : String(previous.image);
  if (!req.release || before === undefined || before === image) return { image, traffic_percent: 100 };
  const percent = req.release.strategy === 'canary' ? req.release.trafficPercent : 100;
  return { image, traffic_percent: percent, previous_image: before, release_strategy: req.release.strategy };
}

function outputsFor(req: ResourceRequest, region: string, simulate: string, id: string): ResourceOutputs {
  const short = id.slice(-10);
  const domain = `${simulate}.sim.internal`;
  switch (req.serviceKind) {
    case 'network':
      // A NAT gateway gives the network a fixed egress address (TEST-NET-3, never routable).
      return { networkId: `net-${short}`, privateSubnets: 2, publicSubnets: 2, egress_ips: req.spec.natGateway ? `203.0.113.${(parseInt(short.slice(-2), 36) % 250) + 1}` : '' };
    case 'container-registry':
      return { repositoryUri: `registry.${region}.${domain}/${req.name}` };
    case 'compute.container-service':
      return { serviceId: id, internalEndpoint: `http://${req.name}.svc.${domain}:${req.spec.port ?? 8080}` };
    case 'database.postgresql': {
      const ref = `secret://${req.name}/credentials`;
      const allowed = allowlistAddresses(req.spec, req.dependencyOutputs);
      const backup = (req.spec.backup ?? {}) as { enabled?: boolean; retentionDays?: number };
      return {
        host: `${req.name}.pg.${region}.${domain}`,
        port: 5432,
        backup_retention_days: backup.enabled === false ? 0 : (backup.retentionDays ?? 7),
        secretRef: ref,
        secret_ref: ref,
        provider: simulate,
        ...(allowed.length ? { allowed_ips: allowed.join(',') } : {}),
      };
    }
    case 'cache.redis':
      return { host: `${req.name}.redis.${region}.${domain}`, port: 6379 };
    case 'queue':
      return { queueUrl: `https://queue.${region}.${domain}/${req.name}` };
    case 'object-storage':
      return { bucket: req.name, endpoint: `https://${req.name}.objects.${region}.${domain}` };
    case 'ingress':
      return { dnsName: `${req.name}.lb.${region}.${domain}` };
    case 'dns': {
      const custom = Array.isArray(req.spec.customDomains) ? (req.spec.customDomains as string[]) : [];
      return { fqdn: `${String(req.spec.subdomainLabel ?? req.name)}.platform.example.test`, tls: 'issued', ...(custom.length ? { custom_domains: custom.join(',') } : {}) };
    }
    case 'web.frontend': {
      const domains = Array.isArray(req.spec.domains) ? (req.spec.domains as string[]) : [];
      return { url: `https://${req.name}.web.${domain}`, project_id: id, ...(domains.length ? { domains: domains.join(',') } : {}) };
    }
    default:
      return {};
  }
}
