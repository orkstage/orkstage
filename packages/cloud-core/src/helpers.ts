// SPDX-License-Identifier: AGPL-3.0-only
import type { CloudProvider, FailureClass } from '@orkstage/domain';
import { ProviderError, type HealthResult, type ResourceOutputs } from './types.js';

type Deps = Record<string, ResourceOutputs>;

/** Module outputs as flat scalars (what the control plane records). Objects and lists are dropped. */
export function flattenOutputs(all: unknown): ResourceOutputs {
  const out: ResourceOutputs = {};
  for (const [k, v] of Object.entries((all ?? {}) as Record<string, unknown>)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
  }
  return out;
}

export function byKind(deps: Deps, kind: string): ResourceOutputs | undefined {
  return Object.values(deps).find((o) => o.kind === kind);
}

export function needKind(provider: CloudProvider, deps: Deps, kind: string, forWhat: string): ResourceOutputs {
  const found = byKind(deps, kind);
  if (!found) throw new ProviderError(`${provider.toUpperCase()}_MISSING_DEPENDENCY`, `${forWhat} needs a ${kind} in the same placement slot.`, 'VALIDATION_ERROR', provider);
  return found;
}

export const csv = (v: unknown) => String(v ?? '').split(',').filter(Boolean);

/** Environment variable prefix for a dependency, e.g. `orders-db` becomes `ORDERS_DB`. */
export const envKey = (resourceId: string) => resourceId.toUpperCase().replace(/[^A-Z0-9]/g, '_');

const INFRA_KINDS = new Set(['network', 'container-registry', 'dns']);

/**
 * Connection settings a service receives for its dependencies, the same names on every
 * provider: `<ID>_HOST`, `<ID>_PORT`, `<ID>_URL`, `<ID>_BUCKET`, `<ID>_ENDPOINT`, `<ID>_REGION`, and the secret
 * reference as `<ID>_CREDENTIALS_REF` (resolved by the provider module, never by value here).
 */
export function dependencyEnvironment(deps: Deps): { environment: Record<string, string>; secretRefs: Record<string, string> } {
  const environment: Record<string, string> = {};
  const secretRefs: Record<string, string> = {};
  for (const [id, out] of Object.entries(deps)) {
    if (INFRA_KINDS.has(String(out.kind))) continue;
    const key = envKey(id);
    if (out.host) environment[`${key}_HOST`] = String(out.host);
    if (out.port) environment[`${key}_PORT`] = String(out.port);
    if (out.url) environment[`${key}_URL`] = String(out.url);
    if (out.queue_url) environment[`${key}_URL`] = String(out.queue_url);
    if (out.bucket) environment[`${key}_BUCKET`] = String(out.bucket);
    if (out.endpoint) environment[`${key}_ENDPOINT`] = String(out.endpoint);
    if (out.region) environment[`${key}_REGION`] = String(out.region);
    if (out.secret_ref) secretRefs[key] = String(out.secret_ref);
  }
  return { environment, secretRefs };
}

/**
 * Environment variables for credentials a dependency published (see `ProviderContext.dependencySecret`):
 * `<ID>_URL`, `<ID>_USERNAME`, `<ID>_PASSWORD`, `<ID>_ACCESS_KEY_ID`, `<ID>_SECRET_ACCESS_KEY`,
 * `<ID>_API_KEY` and so on, one per field. Platforms store them as encrypted or sensitive values.
 */
export function secretEnvironment(resourceId: string, fields: Record<string, string>): Record<string, string> {
  const key = envKey(resourceId);
  return Object.fromEntries(
    Object.entries(fields)
      .filter(([, v]) => typeof v === 'string' && v.length > 0)
      .map(([k, v]) => [`${key}_${k.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}`, v]),
  );
}

/**
 * Removes things that identify an account from provider error text (ids, OCIDs, ARNs, emails,
 * long tokens) and caps the length, so messages are safe to show and store.
 */
export function redact(text: string, max = 240): string {
  return text
    .replace(/arn:aws[^\s"']*/g, '<arn>')
    .replace(/ocid1\.[a-z0-9._-]+/gi, '<ocid>')
    .replace(/\/subscriptions\/[0-9a-f-]{36}/gi, '/subscriptions/<id>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '<token>')
    .slice(0, max);
}

export function safeMessage(err: unknown): string {
  const e = err as { name?: string; message?: string };
  return `${e.name ?? 'Error'}: ${redact(e.message ?? 'unknown error')}`;
}

export const now = () => new Date().toISOString();

/**
 * Addresses a database firewall allows for consumers on other providers: the `egress_ips` of the
 * networks the compiler listed in `spec.allowlistNetworks` (open item 4). Empty when there are none
 * or a network has no NAT gateway (no fixed egress).
 */
export function allowlistAddresses(spec: Record<string, unknown>, deps: Deps): string[] {
  const networks = Array.isArray(spec.allowlistNetworks) ? (spec.allowlistNetworks as string[]) : [];
  const ips = networks.flatMap((id) => String(deps[id]?.egress_ips ?? '').split(',')).map((ip) => ip.trim());
  return [...new Set(ips.filter((ip) => /^\d{1,3}(\.\d{1,3}){3}$/.test(ip)))].sort();
}

/**
 * How an IaC adapter keeps a deployment's plan for its apply: under the deployment id, strict in
 * production (a plan that no longer matches fails the step instead of applying something else).
 */
export function savedPlanFor(req: { planId?: string; tags: Record<string, string> }): { id: string; strict: boolean } | undefined {
  return req.planId ? { id: req.planId, strict: req.tags['platform:environment'] === 'production' } : undefined;
}

/**
 * HTTP reachability check used for public endpoints (service URLs, platform deployments).
 * 2xx and 3xx are healthy, 4xx is degraded (the app answers but not on that path), 5xx and
 * network errors are unhealthy.
 */
export async function httpHealth(url: string, opts: { fetch?: typeof fetch; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<HealthResult> {
  const started = Date.now();
  const signal = AbortSignal.any([AbortSignal.timeout(opts.timeoutMs ?? 10_000), ...(opts.signal ? [opts.signal] : [])]);
  try {
    const res = await (opts.fetch ?? fetch)(url, { method: 'GET', redirect: 'manual', signal });
    const latencyMs = Date.now() - started;
    const state = res.status < 400 ? 'HEALTHY' : res.status < 500 ? 'DEGRADED' : 'UNHEALTHY';
    return { state, message: `HTTP ${res.status} from ${new URL(url).host}`, latencyMs, checkedAt: now() };
  } catch (err) {
    return { state: 'UNHEALTHY', message: `${new URL(url).host} unreachable: ${safeMessage(err)}`, checkedAt: now() };
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/**
 * JSON request with a timeout and redacted errors, for provider REST APIs. Returns `null` for a
 * 404 when `allow404` is set (existence probes).
 */
export async function requestJson<T>(
  url: string,
  init: RequestInit & { fetch?: typeof fetch; timeoutMs?: number; allow404?: boolean } = {},
): Promise<T | null> {
  const { fetch: f = fetch, timeoutMs = 20_000, allow404, signal, ...rest } = init;
  const res = await f(url, { ...rest, signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]) });
  if (res.status === 404 && allow404) return null;
  const text = await res.text();
  if (!res.ok) throw new HttpError(res.status, `HTTP ${res.status} from ${new URL(url).host}: ${redact(text, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

/** Failure class for an HTTP status from a provider API. */
export function failureClassForStatus(status: number): FailureClass {
  if (status === 401) return 'AUTHENTICATION_ERROR';
  if (status === 403) return 'AUTHORIZATION_ERROR';
  if (status === 404) return 'VALIDATION_ERROR';
  if (status === 409) return 'RESOURCE_CONFLICT';
  if (status === 429) return 'PROVIDER_RATE_LIMIT';
  if (status >= 500) return 'NETWORK_ERROR';
  return 'VALIDATION_ERROR';
}
