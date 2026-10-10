import { httpHealth, type HealthResult, type LogLine, type ResourceOutputs } from '@orkstage/cloud-core';
import type { HealthState } from '@orkstage/domain';
import { ARM, azureJson } from './auth.js';

/** ARM api-version per resource type (namespace/type, lower case). */
const API_VERSIONS: Record<string, string> = {
  'microsoft.network/virtualnetworks': '2024-05-01',
  'microsoft.app/containerapps': '2025-07-01',
  'microsoft.app/managedenvironments': '2025-07-01',
  'microsoft.dbforpostgresql/flexibleservers': '2024-08-01',
  'microsoft.cache/redisenterprise': '2025-07-01',
  'microsoft.storage/storageaccounts': '2023-05-01',
  'microsoft.cdn/profiles': '2024-02-01',
};

const ARM_ID = /^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/([^/]+)\/([^/]+)\/[^/]+$/i;

/** ARM URL for a resource id, with the api-version of its type. */
export function armUrl(id: string, suffix = ''): string {
  const m = ARM_ID.exec(id);
  const version = m ? API_VERSIONS[`${m[1]}/${m[2]}`.toLowerCase()] : undefined;
  if (!m || !version) throw new Error(`Unsupported Azure resource id for ${m ? `${m[1]}/${m[2]}` : 'this resource'}.`);
  return `${ARM}${id.split('/').map(encodeURIComponent).join('/')}${suffix}?api-version=${version}`;
}

/** The main ARM resource id recorded in a resource's outputs. */
export function mainResourceId(outputs: ResourceOutputs): string | undefined {
  const id = outputs.service_id ?? outputs.resource_id ?? outputs.network_id;
  return id ? String(id) : undefined;
}

interface ArmResource {
  properties?: {
    provisioningState?: string;
    runningStatus?: string;
    state?: string;
    resourceState?: string;
    statusOfPrimary?: string;
    latestRevisionName?: string;
    latestReadyRevisionName?: string;
  };
}

export interface ArmReader {
  fetch: typeof fetch;
  token: () => Promise<string>;
  signal?: AbortSignal;
}

export async function getArm(r: ArmReader, id: string, allow404 = false): Promise<ArmResource | null> {
  return azureJson<ArmResource>(r.fetch, armUrl(id), await r.token(), { signal: r.signal, allow404 });
}

const result = (state: HealthState, message: string, started: number): HealthResult => ({ state, message, latencyMs: Date.now() - started, checkedAt: new Date().toISOString() });

function provisioning(p: string | undefined): HealthState {
  if (!p || /^succeeded$/i.test(p)) return 'HEALTHY';
  if (/failed|canceled/i.test(p)) return 'UNHEALTHY';
  return 'DEGRADED';
}

/**
 * Actual state of one resource from Azure Resource Manager, using the ids in its OpenTofu
 * outputs, plus an HTTP check of public URLs.
 */
export async function checkAzureHealth(r: ArmReader, kind: string, out: ResourceOutputs): Promise<HealthResult> {
  const started = Date.now();
  if (kind === 'ingress' && out.mode === 'container-apps-builtin') return result('HEALTHY', 'Built in ingress of Container Apps (each service has its own address).', started);
  const id = mainResourceId(out);
  if (!id) return result('UNKNOWN', 'No Azure resource id recorded for this resource.', started);
  const res = await getArm(r, id, true);
  if (!res) return result('UNHEALTHY', 'Resource not found in Azure.', started);
  const p = res.properties ?? {};
  const prov = provisioning(p.provisioningState);
  if (prov !== 'HEALTHY') return result(prov, `Provisioning ${p.provisioningState}`, started);

  switch (kind) {
    case 'network': {
      if (out.container_app_environment_id) {
        const env = await getArm(r, String(out.container_app_environment_id), true);
        const envState = provisioning(env?.properties?.provisioningState);
        if (!env) return result('DEGRADED', 'Virtual network ready, Container Apps environment missing.', started);
        if (envState !== 'HEALTHY') return result(envState, `Container Apps environment ${env.properties?.provisioningState}`, started);
      }
      return result('HEALTHY', 'Virtual network and environment ready', started);
    }
    case 'compute.container-service': {
      const running = p.runningStatus ?? 'unknown';
      if (/stopped|suspended/i.test(running)) return result('UNHEALTHY', `Container app ${running}`, started);
      if (!/running|ready/i.test(running)) return result('DEGRADED', `Container app ${running}`, started);
      if (out.url && String(out.url).startsWith('https://') && !String(out.url).includes('.internal.')) {
        const http = await httpHealth(String(out.url), { fetch: r.fetch, signal: r.signal });
        return { ...http, message: `Container app ${running}; ${http.message}` };
      }
      return result('HEALTHY', `Container app ${running}`, started);
    }
    case 'database.postgresql': {
      const state = p.state ?? 'unknown';
      const health: HealthState = /^ready$/i.test(state) ? 'HEALTHY' : /starting|updating|restarting|provisioning/i.test(state) ? 'DEGRADED' : 'UNHEALTHY';
      return result(health, `PostgreSQL ${state}`, started);
    }
    case 'cache.redis': {
      const state = p.resourceState ?? 'unknown';
      const health: HealthState = /^running$/i.test(state) ? 'HEALTHY' : /failed|disabled/i.test(state) ? 'UNHEALTHY' : 'DEGRADED';
      return result(health, `Redis ${state}`, started);
    }
    case 'object-storage': {
      const status = p.statusOfPrimary ?? 'available';
      return result(/available/i.test(status) ? 'HEALTHY' : 'UNHEALTHY', `Storage account ${status}`, started);
    }
    case 'ingress': {
      if (!out.url) return result('HEALTHY', 'Front Door profile ready', started);
      const http = await httpHealth(String(out.url), { fetch: r.fetch, signal: r.signal });
      return { ...http, message: `Front Door ready; ${http.message}` };
    }
    default:
      return result('HEALTHY', `Provisioning ${p.provisioningState ?? 'Succeeded'}`, started);
  }
}

/** Container app console logs from Log Analytics, newest first. */
export async function containerAppLogs(fetchImpl: typeof fetch, token: string, workspaceId: string, appName: string, limit: number, signal?: AbortSignal): Promise<LogLine[]> {
  if (!/^[0-9a-f-]{36}$/i.test(workspaceId) || !/^[a-z0-9-]{1,64}$/.test(appName)) return [];
  const take = Math.max(1, Math.min(1000, Math.floor(limit)));
  const query = `ContainerAppConsoleLogs_CL | where ContainerAppName_s == '${appName}' | project TimeGenerated, Log_s, Stream_s | order by TimeGenerated desc | take ${take}`;
  const res = await azureJson<{ tables?: { columns: { name: string }[]; rows: unknown[][] }[] }>(
    fetchImpl,
    `https://api.loganalytics.io/v1/workspaces/${workspaceId}/query`,
    token,
    { method: 'POST', body: { query, timespan: 'P1D' }, signal },
  ).catch(() => null); // the table only exists after the first log line arrives
  const table = res?.tables?.[0];
  if (!table) return [];
  const col = (n: string) => table.columns.findIndex((c) => c.name === n);
  const [t, l, s] = [col('TimeGenerated'), col('Log_s'), col('Stream_s')];
  return table.rows.map((row) => ({
    timestamp: String(row[t] ?? ''),
    level: row[s] === 'stderr' ? 'warn' : 'info',
    message: String(row[l] ?? ''),
  }));
}
