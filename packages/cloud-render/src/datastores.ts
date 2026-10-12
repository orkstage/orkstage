// SPDX-License-Identifier: AGPL-3.0-only
import { ProviderError, type ProviderContext, type ResourceOutputs, type ResourceRequest, type ResourceResult } from '@orkstage/cloud-core';
import type { IpRule, KeyValue, Postgres, RenderApi } from './api.js';
import { KEY_VALUE_PLANS, POSTGRES_PLANS, postgresDiskGb, postgresSupportsHa } from './plans.js';

export const POSTGRES_REF = 'render-postgres://';
export const KEY_VALUE_REF = 'render-kv://';

interface PostgresConnectionInfo {
  password: string;
  internalConnectionString: string;
  externalConnectionString: string;
}

interface KeyValueConnectionInfo {
  internalConnectionString: string;
  externalConnectionString: string;
}

/** Parses a connection string without ever putting it in an error message. */
function parseConnection(value: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new ProviderError('RENDER_CONNECTION_STRING_INVALID', 'Render returned a connection string that does not parse.', 'UNKNOWN', 'render');
  }
}

export function parseSecretRef(ref: string): { kind: 'postgres' | 'key-value'; id: string } | null {
  if (ref.startsWith(POSTGRES_REF)) return { kind: 'postgres', id: ref.slice(POSTGRES_REF.length) };
  if (ref.startsWith(KEY_VALUE_REF)) return { kind: 'key-value', id: ref.slice(KEY_VALUE_REF.length) };
  return null;
}

/**
 * Credentials behind a `render-postgres://` or `render-kv://` reference: `url` is the external
 * connection string, `internalUrl` the one for Render services in the same region.
 */
export async function readRenderSecret(api: RenderApi, ref: string): Promise<Record<string, string>> {
  const parsed = parseSecretRef(ref);
  if (!parsed || !/^[a-z]+-[a-z0-9-]+$/.test(parsed.id)) {
    throw new ProviderError('RENDER_SECRET_REF_UNKNOWN', 'Expected render-postgres://<id> or render-kv://<id>.', 'VALIDATION_ERROR', 'render');
  }
  if (parsed.kind === 'postgres') {
    const pg = await api.call<Postgres>('GET', `/postgres/${parsed.id}`);
    const info = await api.call<PostgresConnectionInfo>('GET', `/postgres/${parsed.id}/connection-info`, { quiet: true });
    if (!pg || !info) throw new ProviderError('RENDER_SECRET_NOT_FOUND', `Postgres ${parsed.id} returned no connection info.`, 'VALIDATION_ERROR', 'render');
    const ext = parseConnection(info.externalConnectionString);
    return {
      url: info.externalConnectionString,
      internalUrl: info.internalConnectionString,
      username: pg.databaseUser,
      password: info.password,
      host: ext.hostname,
      port: ext.port || '5432',
      database: pg.databaseName,
    };
  }
  const info = await api.call<KeyValueConnectionInfo>('GET', `/key-value/${parsed.id}/connection-info`, { quiet: true });
  if (!info) throw new ProviderError('RENDER_SECRET_NOT_FOUND', `Key Value ${parsed.id} returned no connection info.`, 'VALIDATION_ERROR', 'render');
  const ext = parseConnection(info.externalConnectionString);
  return {
    url: info.externalConnectionString,
    internalUrl: info.internalConnectionString,
    username: decodeURIComponent(ext.username),
    password: decodeURIComponent(ext.password),
    host: ext.hostname,
    port: ext.port || '6379',
  };
}

/** External host name only, read from the connection string (the password is discarded). */
async function externalHost(api: RenderApi, path: string, fallback: string): Promise<string> {
  try {
    const info = await api.call<{ externalConnectionString?: string }>('GET', path, { quiet: true });
    return info?.externalConnectionString ? parseConnection(info.externalConnectionString).hostname : fallback;
  } catch {
    return fallback;
  }
}

const sameRules = (a: IpRule[] = [], b: IpRule[] = []) =>
  a.map((r) => r.cidrBlock).sort().join(',') === b.map((r) => r.cidrBlock).sort().join(',');

const publicRules = (open: boolean): IpRule[] => (open ? [{ cidrBlock: '0.0.0.0/0', description: 'everywhere' }] : []);

/** Database and user names: lowercase letters, digits and underscores. */
const dbIdentifier = (resourceId: string) => resourceId.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/^([^a-z])/, 'db_$1');

// ───────────────────────── Postgres ─────────────────────────

export async function findPostgres(api: RenderApi, ownerId: string, name: string): Promise<Postgres | undefined> {
  const rows = await api.list<Postgres>('/postgres', 'postgres', { name: [name], ownerId: [ownerId] });
  return rows.find((p) => p.name === name);
}

export async function postgresOutputs(api: RenderApi, pg: Postgres, ownerId: string): Promise<ResourceOutputs> {
  return {
    kind: 'database.postgresql',
    postgres_id: pg.id,
    host: await externalHost(api, `/postgres/${pg.id}/connection-info`, `${pg.id}.${pg.region}-postgres.render.com`),
    internal_host: pg.id,
    port: 5432,
    database: pg.databaseName,
    username: pg.databaseUser,
    secret_ref: `${POSTGRES_REF}${pg.id}`,
    owner_id: pg.owner?.id ?? ownerId,
    region: pg.region,
    dashboard_url: pg.dashboardUrl,
  };
}

export async function ensurePostgres(ctx: ProviderContext, api: RenderApi, ownerId: string, req: ResourceRequest): Promise<ResourceResult> {
  const spec = req.spec as { version?: string; size?: string; storageGiB?: number; highAvailability?: string; publicAccess?: boolean };
  const version = String(spec.version ?? '17');
  const plan = POSTGRES_PLANS[spec.size ?? 'small'] ?? POSTGRES_PLANS.small!;
  const wantHa = (spec.highAvailability ?? 'none') !== 'none';
  const ha = wantHa && postgresSupportsHa(plan, version);
  if (wantHa && !ha) ctx.log?.('warn', `High availability needs at least 1 CPU and PostgreSQL 13; plan ${plan} with version ${version} runs without a standby.`);
  const diskSizeGB = postgresDiskGb(spec.storageGiB ?? 20);
  const ipAllowList = publicRules(spec.publicAccess === true);

  const existing = await findPostgres(api, ownerId, req.name);
  if (!existing) {
    const database = dbIdentifier(req.resourceId);
    const created = await api.call<Postgres>('POST', '/postgres', {
      body: { name: req.name, ownerId, plan, version, region: ctx.region, diskSizeGB, enableHighAvailability: ha, ipAllowList, databaseName: database, databaseUser: `${database}_user` },
    });
    if (!created) throw new ProviderError('RENDER_EMPTY_RESPONSE', 'Render returned no Postgres after create.', 'UNKNOWN', 'render');
    ctx.log?.('info', `Created Render Postgres ${created.id} (${plan}, ${ctx.region}).`);
    return { providerResourceId: created.id, outputs: await postgresOutputs(api, created, ownerId), unchanged: false };
  }

  if (existing.region !== ctx.region) ctx.log?.('warn', `Postgres ${existing.id} is in ${existing.region}; Render cannot move it to ${ctx.region}.`);
  if (String(existing.version) !== version) ctx.log?.('warn', `Postgres ${existing.id} runs version ${existing.version}; major upgrades are not done in place.`);
  const patch: Record<string, unknown> = {};
  if (existing.plan !== plan) patch.plan = plan;
  if ((existing.diskSizeGB ?? 0) < diskSizeGB) patch.diskSizeGB = diskSizeGB;
  if (Boolean(existing.highAvailabilityEnabled) !== ha) patch.enableHighAvailability = ha;
  if (!sameRules(existing.ipAllowList, ipAllowList)) patch.ipAllowList = ipAllowList;
  if (Object.keys(patch).length === 0) {
    return { providerResourceId: existing.id, outputs: await postgresOutputs(api, existing, ownerId), unchanged: true };
  }
  const updated = (await api.call<Postgres>('PATCH', `/postgres/${existing.id}`, { body: patch })) ?? existing;
  ctx.log?.('info', `Updated Render Postgres ${existing.id}: ${Object.keys(patch).join(', ')}.`);
  return { providerResourceId: existing.id, outputs: await postgresOutputs(api, { ...existing, ...updated }, ownerId), unchanged: false };
}

// ───────────────────────── Key Value ─────────────────────────

export async function findKeyValue(api: RenderApi, ownerId: string, name: string): Promise<KeyValue | undefined> {
  const rows = await api.list<KeyValue>('/key-value', 'keyValue', { name: [name], ownerId: [ownerId] });
  return rows.find((k) => k.name === name);
}

export async function keyValueOutputs(api: RenderApi, kv: KeyValue, ownerId: string): Promise<ResourceOutputs> {
  return {
    kind: 'cache.redis',
    key_value_id: kv.id,
    host: await externalHost(api, `/key-value/${kv.id}/connection-info`, `${kv.region}-keyvalue.render.com`),
    internal_host: kv.id,
    port: 6379,
    secret_ref: `${KEY_VALUE_REF}${kv.id}`,
    owner_id: kv.owner?.id ?? ownerId,
    region: kv.region,
    dashboard_url: kv.dashboardUrl,
  };
}

export async function ensureKeyValue(ctx: ProviderContext, api: RenderApi, ownerId: string, req: ResourceRequest): Promise<ResourceResult> {
  const spec = req.spec as { size?: string; replicas?: number; publicAccess?: boolean };
  const plan = KEY_VALUE_PLANS[spec.size ?? 'micro'] ?? KEY_VALUE_PLANS.micro!;
  if ((spec.replicas ?? 0) > 0) ctx.log?.('warn', 'Render Key Value is a single node; replicas are ignored.');
  const ipAllowList = publicRules(spec.publicAccess === true);

  const existing = await findKeyValue(api, ownerId, req.name);
  if (!existing) {
    const created = await api.call<KeyValue>('POST', '/key-value', { body: { name: req.name, ownerId, plan, region: ctx.region, ipAllowList } });
    if (!created) throw new ProviderError('RENDER_EMPTY_RESPONSE', 'Render returned no Key Value after create.', 'UNKNOWN', 'render');
    ctx.log?.('info', `Created Render Key Value ${created.id} (${plan}, ${ctx.region}).`);
    return { providerResourceId: created.id, outputs: await keyValueOutputs(api, created, ownerId), unchanged: false };
  }

  if (existing.region !== ctx.region) ctx.log?.('warn', `Key Value ${existing.id} is in ${existing.region}; Render cannot move it to ${ctx.region}.`);
  const patch: Record<string, unknown> = {};
  if (existing.plan !== plan) patch.plan = plan;
  if (!sameRules(existing.ipAllowList, ipAllowList)) patch.ipAllowList = ipAllowList;
  if (Object.keys(patch).length === 0) {
    return { providerResourceId: existing.id, outputs: await keyValueOutputs(api, existing, ownerId), unchanged: true };
  }
  const updated = (await api.call<KeyValue>('PATCH', `/key-value/${existing.id}`, { body: patch })) ?? existing;
  ctx.log?.('info', `Updated Render Key Value ${existing.id}: ${Object.keys(patch).join(', ')}.`);
  return { providerResourceId: existing.id, outputs: await keyValueOutputs(api, { ...existing, ...updated }, ownerId), unchanged: false };
}
