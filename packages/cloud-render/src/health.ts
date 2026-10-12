// SPDX-License-Identifier: AGPL-3.0-only
import { httpHealth, now, redact, type HealthResult, type LogLine, type ProviderDeployment } from '@orkstage/cloud-core';
import type { HealthState } from '@orkstage/domain';
import type { DatastoreStatus, Deploy, DeployStatus, LogEntry, RenderApi, Service } from './api.js';

const DEPLOY_STATUS: Record<DeployStatus, ProviderDeployment['status']> = {
  created: 'queued',
  queued: 'queued',
  build_in_progress: 'building',
  pre_deploy_in_progress: 'building',
  update_in_progress: 'deploying',
  live: 'live',
  deactivated: 'superseded',
  build_failed: 'failed',
  update_failed: 'failed',
  pre_deploy_failed: 'failed',
  canceled: 'cancelled',
};

/** A Render deploy as a provider deployment; the revision is the commit SHA or the image digest. */
export function toDeployment(d: Deploy): ProviderDeployment {
  const revision = d.commit?.id ?? d.image?.sha;
  const message = d.commit?.message ?? (d.trigger ? `Triggered by ${d.trigger.replace(/_/g, ' ')}` : undefined);
  return {
    id: d.id,
    status: d.status ? DEPLOY_STATUS[d.status] : 'queued',
    createdAt: d.createdAt ?? now(),
    ...(d.finishedAt ? { finishedAt: d.finishedAt } : {}),
    ...(revision ? { revision } : {}),
    ...(message ? { message: redact(message, 200) } : {}),
  };
}

const result = (state: HealthState, message: string, started: number): HealthResult => ({ state, message, latencyMs: Date.now() - started, checkedAt: now() });

/** Suspended by the workspace owner is maintenance; suspended by billing or Render is an outage. */
function suspendedState(suspenders: string[] = []): HealthState {
  return suspenders.length > 0 && suspenders.every((s) => s === 'user') ? 'MAINTENANCE' : 'UNHEALTHY';
}

/**
 * Service health: suspension, then the latest deploy (live is healthy, failed is unhealthy, in
 * progress is degraded), then an HTTP probe on the public URL and health check path when there is one.
 */
export async function serviceHealth(api: RenderApi, svc: Service, opts: { fetch?: typeof fetch; signal?: AbortSignal } = {}): Promise<HealthResult> {
  const started = Date.now();
  if (svc.suspended === 'suspended') return result(suspendedState(svc.suspenders), `Suspended (${(svc.suspenders ?? []).join(', ') || 'unknown'})`, started);
  const rows = (await api.call<{ deploy: Deploy }[]>('GET', `/services/${svc.id}/deploys`, { query: { limit: 1 } })) ?? [];
  const latest = rows[0]?.deploy;
  if (!latest?.status) return result('UNKNOWN', 'No deploys yet', started);
  const status = latest.status;
  if (['build_failed', 'update_failed', 'pre_deploy_failed'].includes(status)) return result('UNHEALTHY', `Deploy ${latest.id} ${status.replace(/_/g, ' ')}`, started);
  if (status !== 'live') return result('DEGRADED', `Deploy ${latest.id} ${status.replace(/_/g, ' ')}`, started);
  const url = svc.serviceDetails.url;
  if (svc.type === 'private_service' || !url) return result('HEALTHY', `Deploy ${latest.id} live`, started);
  const path = svc.type === 'web_service' ? svc.serviceDetails.healthCheckPath || '/' : '/';
  const http = await httpHealth(new URL(path, url).toString(), opts);
  return { ...http, message: `Deploy ${latest.id} live; ${http.message ?? ''}`.trim() };
}

const DATASTORE_STATE: Record<DatastoreStatus, HealthState> = {
  available: 'HEALTHY',
  maintenance_scheduled: 'HEALTHY',
  creating: 'DEGRADED',
  config_restart: 'DEGRADED',
  maintenance_in_progress: 'DEGRADED',
  updating_instance: 'DEGRADED',
  recovery_in_progress: 'DEGRADED',
  suspended: 'MAINTENANCE',
  unavailable: 'UNHEALTHY',
  recovery_failed: 'UNHEALTHY',
  unknown: 'UNKNOWN',
};

/** Render Postgres and Key Value health from their reported status. */
export function datastoreHealth(label: string, status: DatastoreStatus, started = Date.now()): HealthResult {
  return result(DATASTORE_STATE[status] ?? 'UNKNOWN', `${label} ${status.replace(/_/g, ' ')}`, started);
}

function logLevel(value: string | undefined): LogLine['level'] {
  const v = (value ?? '').toLowerCase();
  if (v.startsWith('err') || v === 'fatal' || v === 'critical') return 'error';
  if (v.startsWith('warn')) return 'warn';
  if (v === 'debug' || v === 'trace') return 'debug';
  return 'info';
}

/** A Render log entry as a log line, with account identifiers and tokens redacted. */
export function toLogLine(e: LogEntry): LogLine {
  const labels = Object.fromEntries((e.labels ?? []).map((l) => [l.name, l.value]));
  const attributes = Object.fromEntries(Object.entries(labels).filter(([k]) => k !== 'resource' && k !== 'level' && k !== 'text'));
  return {
    timestamp: e.timestamp,
    level: logLevel(labels.level),
    message: redact(e.message ?? '', 2000),
    ...(Object.keys(attributes).length ? { attributes } : {}),
  };
}
