import { createHash } from 'node:crypto';
import {
  now,
  ProviderError,
  readCredentialFields,
  redact,
  safeMessage,
  type CloudCapability,
  type CloudProviderAdapter,
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
  type ResourceResult,
  type ResourceState,
  type SecretResolver,
  type TargetValidationCheck,
  type TargetValidationResult,
  type ValidateTargetOptions,
} from '@orkstage/cloud-core';
import type { FailureClass, HealthState } from '@orkstage/domain';
import { GONE, SupabaseApi, type Bucket, type Project, type ProjectStatus } from './api.js';
import { SUPABASE_CAPABILITIES } from './catalog.js';
import { apiUrl, configChecks, dashboardUrl, projectHost, s3Endpoint, supabaseConfig, type SupabaseCredentials } from './config.js';
import { LOG_SOURCES, logsQuery, projectHealth, servicesHealth, toLogLines } from './health.js';

export const DATABASE_CAPABILITY = 'supabase-postgres';
export const STORAGE_CAPABILITY = 'supabase-storage';

/** Template sizes that map one to one to Supabase compute sizes (`desired_instance_size`). */
const SIZES = new Set(['micro', 'small', 'medium', 'large', 'xlarge']);

/** States a starting project never leaves on its own. */
const STUCK: ReadonlySet<ProjectStatus> = new Set(['INIT_FAILED', 'RESTORE_FAILED', 'PAUSE_FAILED', 'INACTIVE', 'REMOVED', 'GOING_DOWN']);

export interface SupabaseAdapterOptions {
  resolveSecret: SecretResolver;
  fetch?: typeof fetch;
  /**
   * Deterministic secret from the platform's encryption key (HMAC of `purpose`). The database
   * password is derived again whenever it is needed, so it is never stored.
   */
  deriveSecret: (purpose: string) => string;
  /** How often to poll a starting project (default 10 seconds). */
  pollIntervalMs?: number;
  /** How long to wait for a new project to become healthy (default 15 minutes). */
  pollTimeoutMs?: number;
}

const DATABASE_ACTIONS: ResourceActionDescriptor[] = [
  { name: 'restart', description: 'Restarts the project services (database, API, auth, storage). Connections drop briefly.', params: [] },
  { name: 'pause', description: 'Pauses the project. Data is kept; nothing answers until the restore action runs.', params: [] },
  { name: 'restore', description: 'Resumes a paused project.', params: [] },
  {
    name: 'backup',
    description: 'Creates a named database restore point, where the organization plan offers restore points.',
    params: [{ name: 'name', type: 'string', description: 'Restore point name, at most 20 letters, digits, dashes or underscores. Defaults to ork-<UTC time>.' }],
  },
];

/**
 * Turns the derived secret into a Supabase database password: 32 characters from [A-Za-z0-9]
 * (URL safe, no escaping in connection strings) with every character class present.
 */
export function databasePassword(derived: string): string {
  let pw = createHash('sha256').update(derived).digest('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 32);
  if (!/[a-z]/.test(pw)) pw += 'k';
  if (!/[A-Z]/.test(pw)) pw += 'Q';
  if (!/[0-9]/.test(pw)) pw += '7';
  return pw;
}

const fail = (code: string, message: string, failureClass: FailureClass) => new ProviderError(code, message, failureClass, 'supabase');

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  const cancelled = () => fail('SUPABASE_CANCELLED', 'Cancelled while waiting for the Supabase project.', 'TIMEOUT');
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancelled());
    const onAbort = () => {
      clearTimeout(timer);
      reject(cancelled());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Supabase through the Management API (no OpenTofu). A `supabase-postgres` resource is a whole
 * Supabase project; a `supabase-storage` resource is a bucket inside the project of the
 * supabase-postgres resource it depends on.
 */
export class SupabaseAdapter implements CloudProviderAdapter {
  readonly provider = 'supabase' as const;
  readonly simulated = false;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly opts: SupabaseAdapterOptions) {
    this.fetchFn = opts.fetch ?? ((input, init) => fetch(input, init));
  }

  capabilities(_target: CloudTarget): CloudCapability[] {
    return SUPABASE_CAPABILITIES;
  }

  async validateTarget(ctx: ProviderContext, _opts: ValidateTargetOptions = {}): Promise<TargetValidationResult> {
    const validatedAt = now();
    const checks: TargetValidationCheck[] = configChecks(ctx.target, ctx.region);
    if (checks.some((c) => c.status === 'error')) return { ok: false, checks, validatedAt };

    const slug = supabaseConfig(ctx.target).organizationId;
    let identity: string | undefined;
    try {
      const api = await this.api(ctx);
      const orgs = await api.listOrganizations();
      const org = orgs.find((o) => o.slug === slug || o.id === slug);
      if (!org) {
        checks.push({ name: 'Organization access', status: 'error', message: `The token cannot see organization ${slug} (${orgs.length} organization(s) visible). Check the slug and the token owner's membership.` });
      } else {
        identity = org.name;
        checks.push({ name: 'Credentials', status: 'ok', message: `Token accepted for organization ${org.name}.` });
        const detail = await api.getOrganization(org.slug ?? org.id).catch(() => null);
        if (detail?.plan) {
          checks.push({
            name: 'Plan',
            status: 'ok',
            message: detail.plan === 'free' ? 'Free plan: Nano compute, at most two active projects, paused after a week without activity.' : `Plan ${detail.plan}.`,
          });
        }
      }
    } catch (err) {
      checks.push({ name: 'Credentials', status: 'error', message: err instanceof ProviderError ? err.message : safeMessage(err) });
    }
    return { ok: checks.every((c) => c.status !== 'error' && c.status !== 'missing'), checks, validatedAt, identity };
  }

  async ensureResource(ctx: ProviderContext, req: ResourceRequest): Promise<ResourceResult> {
    if (req.capability === DATABASE_CAPABILITY) return this.ensureDatabase(ctx, req);
    if (req.capability === STORAGE_CAPABILITY) return this.ensureBucket(ctx, req);
    throw fail('SUPABASE_UNSUPPORTED_CAPABILITY', `Supabase does not implement ${req.capability}.`, 'VALIDATION_ERROR');
  }

  async deleteResource(ctx: ProviderContext, resource: ResourceIdentifier): Promise<void> {
    const api = await this.api(ctx);
    if (resource.capability === STORAGE_CAPABILITY) {
      const loc = bucketLocation(resource);
      if (!loc) return;
      const project = await api.getProject(loc.ref);
      if (!project || GONE.has(project.status)) return;
      const { serviceRoleKey } = await api.projectKeys(loc.ref);
      const path = `/bucket/${encodeURIComponent(loc.bucket)}`;
      // Production buckets (or unknown ones) are never emptied: deletion fails while objects remain.
      const protectedBucket = resource.outputs?.deletion_protected !== false;
      if (!protectedBucket) await api.storage(loc.ref, serviceRoleKey, 'POST', `${path}/empty`, { allow404: true });
      try {
        await api.storage(loc.ref, serviceRoleKey, 'DELETE', path, { allow404: true });
      } catch (err) {
        if (protectedBucket && err instanceof ProviderError && err.code === 'SUPABASE_API_ERROR') {
          throw fail('SUPABASE_BUCKET_NOT_EMPTY', `Bucket ${loc.bucket} is deletion protected and could not be deleted (${err.message}). Empty it in the Supabase dashboard first.`, 'POLICY_VIOLATION');
        }
        throw err;
      }
      ctx.log?.('info', `Deleted Supabase Storage bucket ${loc.bucket}.`);
      return;
    }
    const ref = await this.projectRef(ctx, api, resource);
    if (!ref) return;
    await api.mgmt('DELETE', `/v1/projects/${ref}`, { allow404: true });
    ctx.log?.('info', `Deleted Supabase project ${ref}.`);
  }

  async getResource(ctx: ProviderContext, resource: ResourceIdentifier): Promise<ResourceState> {
    const api = await this.api(ctx);
    const missing: ResourceState = { exists: false, outputs: {} };
    if (resource.capability === STORAGE_CAPABILITY) {
      const loc = bucketLocation(resource);
      if (!loc) return missing;
      const project = await api.getProject(loc.ref);
      if (!project || GONE.has(project.status)) return missing;
      const { serviceRoleKey } = await api.projectKeys(loc.ref);
      const bucket = await api.storage<Bucket>(loc.ref, serviceRoleKey, 'GET', `/bucket/${encodeURIComponent(loc.bucket)}`, { allow404: true });
      if (!bucket) return missing;
      const protectedBucket = resource.outputs?.deletion_protected !== false;
      return { exists: true, providerResourceId: `${loc.ref}/${loc.bucket}`, outputs: bucketOutputs(project, loc.bucket, bucket.public, protectedBucket) };
    }
    const ref = await this.projectRef(ctx, api, resource);
    const project = ref ? await api.getProject(ref) : null;
    if (!project || GONE.has(project.status)) return missing;
    return { exists: true, providerResourceId: project.ref, outputs: await databaseOutputs(api, project) };
  }

  async probeExists(ctx: ProviderContext, resource: ResourceIdentifier): Promise<boolean | undefined> {
    try {
      return (await this.getResource(ctx, resource)).exists;
    } catch {
      return undefined;
    }
  }

  async checkHealth(ctx: ProviderContext, resource: ResourceIdentifier): Promise<HealthResult> {
    const started = Date.now();
    const result = (state: HealthState, message: string): HealthResult => ({ state, message, latencyMs: Date.now() - started, checkedAt: now() });
    try {
      const api = await this.api(ctx);
      const storage = resource.capability === STORAGE_CAPABILITY;
      const loc = storage ? bucketLocation(resource) : undefined;
      const ref = storage ? loc?.ref : await this.projectRef(ctx, api, resource);
      if (!ref) return result('UNKNOWN', 'No Supabase project recorded for this resource.');
      const project = await api.getProject(ref);
      if (!project || GONE.has(project.status)) return result('UNHEALTHY', `Supabase project ${ref} was not found.`);
      const byStatus = projectHealth(project.status);
      if (byStatus) return result(byStatus.state, byStatus.message);
      const services = await api.health(ref, storage ? ['storage'] : ['db', 'rest', 'auth', 'storage']);
      const health = servicesHealth(services, storage ? 'storage' : 'db');
      if (storage && loc && health.state === 'HEALTHY') {
        const { serviceRoleKey } = await api.projectKeys(ref);
        const bucket = await api.storage<Bucket>(ref, serviceRoleKey, 'GET', `/bucket/${encodeURIComponent(loc.bucket)}`, { allow404: true });
        if (!bucket) return result('UNHEALTHY', `Bucket ${loc.bucket} was not found.`);
      }
      return result(health.state, health.message);
    } catch (err) {
      return result('UNKNOWN', err instanceof ProviderError ? err.message : safeMessage(err));
    }
  }

  /** Recent lines from the project's unified logs (Postgres or Storage source), oldest first. */
  async getLogs(ctx: ProviderContext, resource: ResourceIdentifier, limit: number): Promise<LogLine[]> {
    const source = LOG_SOURCES[resource.capability];
    if (!source) return [];
    const api = await this.api(ctx);
    const storage = resource.capability === STORAGE_CAPABILITY;
    const ref = storage ? bucketLocation(resource)?.ref : await this.projectRef(ctx, api, resource);
    if (!ref) return [];
    const end = new Date();
    const start = new Date(end.getTime() - 60 * 60 * 1000);
    const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
    const qs = new URLSearchParams({ sql: logsQuery(source, limit), iso_timestamp_start: iso(start), iso_timestamp_end: iso(end) });
    const res = await api.mgmt<{ result?: unknown[]; error?: unknown }>('GET', `/v1/projects/${ref}/analytics/endpoints/logs?${qs}`, { allow404: true });
    if (!res) return [];
    if (res.error) {
      const msg = typeof res.error === 'string' ? res.error : String((res.error as { message?: unknown }).message ?? 'query failed');
      throw fail('SUPABASE_LOGS_ERROR', `Supabase logs query failed: ${redact(msg, 200)}`, 'UNKNOWN');
    }
    return toLogLines(res.result ?? [], source).reverse();
  }

  async readSecret(ctx: ProviderContext, secretRef: string): Promise<Record<string, string>> {
    const m = /^supabase:\/\/([a-z0-9]{1,40})\/(database|storage)$/.exec(secretRef);
    if (!m) throw fail('SUPABASE_SECRET_REF_INVALID', 'Unsupported Supabase secret reference. Expected supabase://<project ref>/database or /storage.', 'VALIDATION_ERROR');
    const [, ref, what] = m as unknown as [string, string, 'database' | 'storage'];
    const api = await this.api(ctx);
    const project = await api.getProject(ref);
    if (!project || GONE.has(project.status)) throw fail('SUPABASE_PROJECT_NOT_FOUND', `Supabase project ${ref} was not found.`, 'VALIDATION_ERROR');
    const org = project.organization_slug ?? project.organization_id;
    const slug = supabaseConfig(ctx.target).organizationId;
    if (org && org !== slug && project.organization_id !== slug) {
      throw fail('SUPABASE_PROJECT_FOREIGN', `Supabase project ${ref} does not belong to organization ${slug}.`, 'AUTHORIZATION_ERROR');
    }

    if (what === 'storage') {
      const keys = await api.projectKeys(ref);
      return { url: apiUrl(ref), serviceRoleKey: keys.serviceRoleKey, ...(keys.anonKey ? { anonKey: keys.anonKey } : {}) };
    }

    const password = this.password(ctx.target, project.name);
    const host = project.database?.host || projectHost(ref);
    const secret: Record<string, string> = {
      url: `postgresql://postgres:${encodeURIComponent(password)}@${host}:5432/postgres?sslmode=require`,
      username: 'postgres',
      password,
      host,
      port: '5432',
      database: 'postgres',
    };
    const pool = await api.pooler(ref).catch(() => undefined);
    if (pool) {
      secret.poolerUrl = `postgresql://${encodeURIComponent(pool.db_user)}:${encodeURIComponent(password)}@${pool.db_host}:${pool.db_port}/${pool.db_name}?sslmode=require`;
    }
    return secret;
  }

  actions(capability: string): ResourceActionDescriptor[] {
    return capability === DATABASE_CAPABILITY ? DATABASE_ACTIONS : [];
  }

  async runAction(ctx: ProviderContext, resource: ResourceIdentifier, request: ResourceActionRequest): Promise<ResourceActionResult> {
    const descriptor = this.actions(resource.capability).find((a) => a.name === request.action);
    if (!descriptor) {
      const available = this.actions(resource.capability).map((a) => a.name);
      throw fail('SUPABASE_ACTION_UNKNOWN', `Action ${request.action} is not available for ${resource.capability}${available.length ? ` (available: ${available.join(', ')})` : ''}.`, 'VALIDATION_ERROR');
    }
    validateParams(descriptor, request.params);
    const api = await this.api(ctx);
    const ref = await this.projectRef(ctx, api, resource);
    if (!ref) throw fail('SUPABASE_PROJECT_NOT_FOUND', `No Supabase project recorded for ${resource.resourceId}.`, 'VALIDATION_ERROR');
    const url = dashboardUrl(ref);

    switch (request.action) {
      case 'restart':
        await api.mgmt('POST', `/v1/projects/${ref}/restart`);
        return { status: 'started', message: `Restart requested for Supabase project ${ref}.`, url };
      case 'pause':
        await api.mgmt('POST', `/v1/projects/${ref}/pause`);
        return { status: 'started', message: `Pause requested for Supabase project ${ref}.`, url };
      case 'restore':
        await api.mgmt('POST', `/v1/projects/${ref}/restore`);
        return { status: 'started', message: `Restore requested for Supabase project ${ref}. It takes a few minutes to come back.`, url };
      default: {
        const name = typeof request.params.name === 'string' ? request.params.name : `ork-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)}`;
        if (!/^[\w-]{1,20}$/.test(name)) throw fail('SUPABASE_ACTION_PARAMS', 'Restore point name must be 1 to 20 letters, digits, dashes or underscores.', 'VALIDATION_ERROR');
        const point = await api.mgmt<{ name?: string; status?: string }>('POST', `/v1/projects/${ref}/database/backups/restore-point`, { body: { name } });
        const done = point?.status === 'AVAILABLE';
        return { reference: name, status: done ? 'completed' : 'started', message: `Restore point ${name} ${done ? 'created' : 'requested'} for Supabase project ${ref}.`, url };
      }
    }
  }

  private async api(ctx: ProviderContext): Promise<SupabaseApi> {
    const creds = await readCredentialFields<SupabaseCredentials>('supabase', ctx, this.opts.resolveSecret, { required: ['token'], singleField: 'token' });
    return new SupabaseApi(creds.token, this.fetchFn, ctx.signal);
  }

  private password(target: CloudTarget, name: string): string {
    return databasePassword(this.opts.deriveSecret(`supabase:db:${target.id}:${name}`));
  }

  /** Live project with this name in the target's organization, ignoring projects being deleted. */
  private async findProject(ctx: ProviderContext, api: SupabaseApi, name: string): Promise<Project | undefined> {
    const slug = supabaseConfig(ctx.target).organizationId;
    const projects = await api.listProjects();
    return projects.find((p) => p.name === name && (p.organization_slug === slug || p.organization_id === slug) && !GONE.has(p.status));
  }

  private async projectRef(ctx: ProviderContext, api: SupabaseApi, resource: ResourceIdentifier): Promise<string | undefined> {
    const known = resource.providerResourceId ?? (resource.outputs?.project_ref as string | undefined);
    if (known) return known;
    return (await this.findProject(ctx, api, resource.name))?.ref;
  }

  private async ensureDatabase(ctx: ProviderContext, req: ResourceRequest): Promise<ResourceResult> {
    const api = await this.api(ctx);
    const slug = supabaseConfig(ctx.target).organizationId;
    const existing = await this.findProject(ctx, api, req.name);
    if (existing) {
      if (existing.region !== ctx.region) {
        throw fail('SUPABASE_REGION_MISMATCH', `Supabase project ${req.name} already exists in ${existing.region}, not ${ctx.region}. A project cannot move regions.`, 'RESOURCE_CONFLICT');
      }
      let project = existing;
      if (project.status === 'INACTIVE') ctx.log?.('warn', `Supabase project ${project.ref} is paused. Run the restore action to resume it.`);
      else if (project.status !== 'ACTIVE_HEALTHY') project = await this.waitActive(ctx, api, project.ref);
      return { providerResourceId: project.ref, outputs: await databaseOutputs(api, project), unchanged: true };
    }

    const body: Record<string, unknown> = {
      name: req.name,
      organization_slug: slug,
      db_pass: this.password(ctx.target, req.name),
      region_selection: { type: 'specific', code: ctx.region },
    };
    const org = await api.getOrganization(slug).catch(() => null);
    const size = String(req.spec.size ?? '');
    if (org?.plan === 'free') ctx.log?.('info', 'Free plan organization: the project runs on the Nano compute size.');
    else if (SIZES.has(size)) body.desired_instance_size = size;
    if (req.spec.highAvailability && req.spec.highAvailability !== 'none') {
      ctx.log?.('warn', 'Supabase does not offer a standby through the Management API; the project is created without high availability.');
    }

    ctx.log?.('info', `Creating Supabase project ${req.name} in ${ctx.region}.`);
    const created = await api.mgmt<Project>('POST', '/v1/projects', { body, timeoutMs: 60_000 });
    if (!created?.ref) throw fail('SUPABASE_CREATE_FAILED', `Supabase did not return a project ref for ${req.name}.`, 'DEPLOYMENT_ERROR');
    const project = await this.waitActive(ctx, api, created.ref);
    return { providerResourceId: project.ref, outputs: await databaseOutputs(api, project), unchanged: false };
  }

  private async ensureBucket(ctx: ProviderContext, req: ResourceRequest): Promise<ResourceResult> {
    const dep = Object.values(req.dependencyOutputs).find((o) => o.kind === 'database.postgresql' && typeof o.project_ref === 'string' && o.project_ref.length > 0);
    if (!dep) {
      throw fail(
        'SUPABASE_MISSING_DEPENDENCY',
        `Storage bucket ${req.name} lives inside a Supabase project. Add dependsOn with a database.postgresql resource placed on Supabase (supabase-postgres).`,
        'VALIDATION_ERROR',
      );
    }
    const ref = String(dep.project_ref);
    const api = await this.api(ctx);
    const found = await api.getProject(ref);
    if (!found || GONE.has(found.status)) throw fail('SUPABASE_PROJECT_NOT_FOUND', `Supabase project ${ref} from the database dependency was not found.`, 'VALIDATION_ERROR');
    const project = found.status === 'ACTIVE_HEALTHY' ? found : await this.waitActive(ctx, api, ref);

    if (req.spec.versioning === true) ctx.log?.('warn', 'Supabase Storage has no object versioning; the setting is ignored.');
    if (typeof req.spec.retentionDays === 'number') ctx.log?.('warn', 'Supabase Storage has no lifecycle rules; retentionDays is ignored.');
    if (req.spec.tier && req.spec.tier !== 'standard') ctx.log?.('warn', `Supabase Storage has a single tier; ${String(req.spec.tier)} is ignored.`);

    const isPublic = req.spec.publicAccess === true;
    const { serviceRoleKey } = await api.projectKeys(ref);
    const path = `/bucket/${encodeURIComponent(req.name)}`;
    const existing = await api.storage<Bucket>(ref, serviceRoleKey, 'GET', path, { allow404: true });
    let unchanged = true;
    if (!existing) {
      ctx.log?.('info', `Creating Supabase Storage bucket ${req.name} in project ${ref}.`);
      await api.storage(ref, serviceRoleKey, 'POST', '/bucket', { body: { id: req.name, name: req.name, public: isPublic } });
      unchanged = false;
    } else if (existing.public !== isPublic) {
      ctx.log?.('info', `Setting bucket ${req.name} ${isPublic ? 'public' : 'private'}.`);
      await api.storage(ref, serviceRoleKey, 'PUT', path, { body: { id: req.name, name: req.name, public: isPublic } });
      unchanged = false;
    }
    const production = req.tags['platform:environment'] === 'production';
    return { providerResourceId: `${ref}/${req.name}`, outputs: bucketOutputs(project, req.name, isPublic, production), unchanged };
  }

  /** Bounded poll until the project is ACTIVE_HEALTHY, reporting each status change. */
  private async waitActive(ctx: ProviderContext, api: SupabaseApi, ref: string): Promise<Project> {
    const interval = this.opts.pollIntervalMs ?? 10_000;
    const limit = this.opts.pollTimeoutMs ?? 15 * 60_000;
    const deadline = Date.now() + limit;
    let last: ProjectStatus | undefined;
    for (;;) {
      const p = await api.getProject(ref);
      if (!p) throw fail('SUPABASE_PROJECT_GONE', `Supabase project ${ref} disappeared while starting.`, 'DEPLOYMENT_ERROR');
      if (p.status === 'ACTIVE_HEALTHY') {
        if (last) ctx.log?.('info', `Supabase project ${ref} is healthy.`);
        return p;
      }
      if (STUCK.has(p.status)) {
        const hint = p.status === 'INACTIVE' ? ' The project is paused; run the restore action.' : '';
        throw fail('SUPABASE_PROJECT_NOT_READY', `Supabase project ${ref} is ${p.status}.${hint}`, 'DEPLOYMENT_ERROR');
      }
      if (p.status !== last) {
        ctx.log?.('info', `Supabase project ${ref} is ${p.status}; waiting for ACTIVE_HEALTHY.`);
        last = p.status;
      }
      if (Date.now() >= deadline) {
        throw fail('SUPABASE_PROJECT_TIMEOUT', `Supabase project ${ref} was still ${p.status} after ${Math.round(limit / 60_000)} minute(s). The next apply resumes waiting.`, 'TIMEOUT');
      }
      await sleep(interval, ctx.signal);
    }
  }
}

function bucketLocation(resource: ResourceIdentifier): { ref: string; bucket: string } | undefined {
  const id = resource.providerResourceId;
  if (id && id.includes('/')) {
    const [ref, bucket] = id.split('/', 2) as [string, string];
    return { ref, bucket };
  }
  const ref = resource.outputs?.project_ref;
  return typeof ref === 'string' && ref ? { ref, bucket: String(resource.outputs?.bucket ?? resource.name) } : undefined;
}

async function databaseOutputs(api: SupabaseApi, project: Project): Promise<ResourceOutputs> {
  const ref = project.ref;
  const out: ResourceOutputs = {
    kind: 'database.postgresql',
    project_ref: ref,
    host: project.database?.host || projectHost(ref),
    port: 5432,
    database: 'postgres',
    username: 'postgres',
    region: project.region,
    api_url: apiUrl(ref),
    dashboard_url: dashboardUrl(ref),
    secret_ref: `supabase://${ref}/database`,
  };
  // Pooler details are a convenience; the project is usable without them.
  const pool = await api.pooler(ref).catch(() => undefined);
  if (pool) {
    out.pooler_host = pool.db_host;
    out.pooler_port = pool.db_port;
    out.pooler_username = pool.db_user;
  }
  return out;
}

function bucketOutputs(project: Project, bucket: string, isPublic: boolean, deletionProtected: boolean): ResourceOutputs {
  const ref = project.ref;
  return {
    kind: 'object-storage',
    bucket,
    endpoint: s3Endpoint(ref),
    region: project.region,
    project_ref: ref,
    api_url: apiUrl(ref),
    public: isPublic,
    ...(isPublic ? { public_url: `${apiUrl(ref)}/storage/v1/object/public/${bucket}` } : {}),
    deletion_protected: deletionProtected,
    secret_ref: `supabase://${ref}/storage`,
  };
}

function validateParams(descriptor: ResourceActionDescriptor, params: ResourceActionRequest['params']): void {
  const known = new Map(descriptor.params.map((p) => [p.name, p]));
  for (const [name, value] of Object.entries(params ?? {})) {
    const spec = known.get(name);
    if (!spec) throw fail('SUPABASE_ACTION_PARAMS', `Action ${descriptor.name} does not accept parameter ${name}.`, 'VALIDATION_ERROR');
    if (typeof value !== spec.type) throw fail('SUPABASE_ACTION_PARAMS', `Parameter ${name} of ${descriptor.name} must be a ${spec.type}.`, 'VALIDATION_ERROR');
  }
  for (const p of descriptor.params) {
    if (p.required && params?.[p.name] === undefined) throw fail('SUPABASE_ACTION_PARAMS', `Action ${descriptor.name} needs parameter ${p.name}.`, 'VALIDATION_ERROR');
  }
}
