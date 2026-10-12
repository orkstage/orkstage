// SPDX-License-Identifier: AGPL-3.0-only
import { httpHealth, now, redact, type HealthResult, type LogLine, type ProviderDeployment } from '@orkstage/cloud-core';
import type { Deployment, DeploymentEvent, ReadyState } from './api.js';

const IN_PROGRESS: ReadonlySet<string> = new Set(['QUEUED', 'INITIALIZING', 'BUILDING', 'BLOCKED']);

/**
 * Health of a frontend: the latest production deployment's state, then an HTTP check of the
 * production URL once it is ready.
 */
export async function frontendHealth(
  latest: Deployment | undefined,
  url: string | undefined,
  path: string,
  opts: { fetch?: typeof fetch; signal?: AbortSignal },
): Promise<HealthResult> {
  if (!latest) return { state: 'UNKNOWN', message: 'No production deployment yet.', checkedAt: now() };
  const state = latest.readyState ?? latest.state;
  if (state === 'ERROR') {
    return { state: 'UNHEALTHY', message: `Latest production deployment failed${latest.errorMessage ? `: ${redact(latest.errorMessage)}` : '.'}`, checkedAt: now() };
  }
  if (state && IN_PROGRESS.has(state)) {
    return { state: 'DEGRADED', message: `Production deployment ${latest.uid} is ${state.toLowerCase()}.`, checkedAt: now() };
  }
  if (!url) return { state: 'UNKNOWN', message: 'The production URL is not known yet.', checkedAt: now() };
  const http = await httpHealth(new URL(path, url).toString(), opts);
  if (state === 'CANCELED') return { ...http, message: `Latest production deployment was canceled; ${http.message ?? ''}`.trim() };
  return http;
}

/** Maps a Vercel deployment to the platform's rollout record. `currentProductionId` marks the live one. */
export function toProviderDeployment(d: Deployment, currentProductionId: string | undefined): ProviderDeployment {
  const meta = d.meta ?? {};
  const revision = meta.githubCommitSha ?? meta.gitlabCommitSha ?? meta.bitbucketCommitSha;
  const message = (meta.githubCommitMessage ?? meta.gitlabCommitMessage ?? meta.bitbucketCommitMessage ?? d.errorMessage)?.split('\n')[0];
  return {
    id: d.uid,
    status: deploymentStatus(d.readyState ?? d.state, d.target, d.uid === currentProductionId),
    createdAt: new Date(d.createdAt).toISOString(),
    ...(d.ready ? { finishedAt: new Date(d.ready).toISOString() } : {}),
    ...(d.url ? { url: `https://${d.url}` } : {}),
    ...(revision ? { revision } : {}),
    ...(message ? { message: redact(message) } : {}),
  };
}

export function deploymentStatus(state: ReadyState | undefined, target: string | null | undefined, isCurrentProduction: boolean): ProviderDeployment['status'] {
  switch (state) {
    case 'QUEUED':
    case 'BLOCKED':
      return 'queued';
    case 'INITIALIZING':
    case 'BUILDING':
      return 'building';
    case 'READY':
      // An older ready production build is still reachable at its URL but no longer serves the domain.
      return target === 'production' && !isCurrentProduction ? 'superseded' : 'live';
    case 'ERROR':
      return 'failed';
    case 'CANCELED':
      return 'cancelled';
    case 'DELETED':
      return 'superseded';
    default:
      return 'queued';
  }
}

/** Build and runtime events as log lines, oldest first, with account details redacted. */
export function toLogLines(events: DeploymentEvent[], deploymentId: string): LogLine[] {
  const lines: LogLine[] = [];
  for (const e of events) {
    const text = (e.text ?? e.payload?.text ?? '').trimEnd();
    if (!text) continue;
    const at = e.created ?? e.date ?? e.payload?.date;
    lines.push({
      timestamp: new Date(at ?? Date.now()).toISOString(),
      level: e.type === 'stderr' || e.type === 'fatal' || e.level === 'error' ? 'error' : e.level === 'warning' ? 'warn' : 'info',
      message: redact(text, 2000),
      attributes: { type: e.type, deploymentId },
    });
  }
  return lines.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}
