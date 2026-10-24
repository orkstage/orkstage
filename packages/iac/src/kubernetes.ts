// SPDX-License-Identifier: AGPL-3.0-only
import { readFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { pause, RemoteSession, type TofuExecResult, type TofuExecutor } from './executor.js';

/** The service account files every pod gets (in cluster configuration). */
export const IN_CLUSTER = {
  apiUrl: 'https://kubernetes.default.svc',
  tokenFile: '/var/run/secrets/kubernetes.io/serviceaccount/token',
  caFile: '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt',
  namespaceFile: '/var/run/secrets/kubernetes.io/serviceaccount/namespace',
};

export interface KubeResponse {
  status: number;
  body: unknown;
}
export type KubeRequest = (method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown) => Promise<KubeResponse>;

/** Kubernetes API calls with the worker's service account (the token file is read per call: it rotates). */
export function kubeClient(opts: { apiUrl?: string; tokenFile?: string; caFile?: string } = {}): KubeRequest {
  const apiUrl = opts.apiUrl ?? IN_CLUSTER.apiUrl;
  return async (method, path, body) => {
    const [token, ca] = await Promise.all([readFile(opts.tokenFile ?? IN_CLUSTER.tokenFile, 'utf8'), readFile(opts.caFile ?? IN_CLUSTER.caFile).catch(() => undefined)]);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = httpsRequest(
        new URL(path, apiUrl),
        {
          method,
          ca,
          timeout: 30_000,
          headers: { authorization: `Bearer ${token.trim()}`, accept: 'application/json', ...(payload ? { 'content-type': 'application/json' } : {}) },
        },
        (res) => {
          let text = '';
          res.on('data', (d: Buffer) => (text += d.toString()));
          res.on('end', () => {
            let parsed: unknown = text;
            try {
              parsed = JSON.parse(text);
            } catch {
              /* not JSON: kept as text */
            }
            resolve({ status: res.statusCode ?? 0, body: parsed });
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error(`Kubernetes API ${method} ${path} timed out`)));
      req.on('error', reject);
      req.end(payload);
    });
  };
}

export interface KubernetesExecutorOptions {
  request: KubeRequest;
  namespace: string;
  /** Runner image with the module library at /modules (the same image Compose uses). */
  image: string;
  /** ReadWriteMany claim that the worker mounts as its work root, mounted at `remoteRoot` in the Job. */
  workClaim: string;
  remoteRoot: string;
  /** Service account of the runner pods; none of its token is mounted. */
  serviceAccount?: string;
  /**
   * User and group of the runner: the worker's, so both can read and remove what the other wrote
   * (the credentials file is readable by its owner only).
   */
  runAsUser?: number;
  runAsGroup?: number;
  resources?: { requests?: Record<string, string>; limits?: Record<string, string> };
  pollMs?: number;
}

interface JobStatus {
  status?: { succeeded?: number; failed?: number; conditions?: { type: string; status: string; reason?: string; message?: string }[] };
}
interface PodList {
  items?: { status?: { containerStatuses?: { state?: { waiting?: { reason?: string; message?: string } } }[] } }[];
}

/** Pod states that never recover by waiting. */
const STUCK = new Set(['ErrImagePull', 'ImagePullBackOff', 'InvalidImageName', 'CreateContainerConfigError', 'CreateContainerError']);

/**
 * One Kubernetes Job per OpenTofu session (ADR 0016). The pod runs as the worker's user, without a
 * service account token, privilege escalation, capabilities or a writable root file system. The
 * worker's role needs `create`, `get` and `delete` on jobs and `list` on pods in the namespace.
 */
export function kubernetesExecutor(opts: KubernetesExecutorOptions): TofuExecutor {
  const pollMs = opts.pollMs ?? 3000;
  const base = `/apis/batch/v1/namespaces/${encodeURIComponent(opts.namespace)}/jobs`;
  return {
    async run(stack, dir, commands, timeoutMs) {
      const session = new RemoteSession(dir, opts.remoteRoot);
      const name = `orkstage-tofu-${session.id}`;
      const uid = opts.runAsUser ?? process.getuid?.();
      const gid = opts.runAsGroup ?? process.getgid?.();
      await session.write(stack, commands);
      let created = false;
      try {
        const labels = { 'app.kubernetes.io/name': 'orkstage-tofu', 'app.kubernetes.io/managed-by': 'orkstage' };
        const job = {
          apiVersion: 'batch/v1',
          kind: 'Job',
          metadata: { name, labels },
          spec: {
            backoffLimit: 0,
            activeDeadlineSeconds: Math.ceil(timeoutMs / 1000),
            ttlSecondsAfterFinished: 600,
            template: {
              metadata: { labels },
              spec: {
                restartPolicy: 'Never',
                automountServiceAccountToken: false,
                ...(opts.serviceAccount ? { serviceAccountName: opts.serviceAccount } : {}),
                securityContext: {
                  ...(uid !== undefined ? { runAsUser: uid, runAsNonRoot: uid !== 0 } : {}),
                  ...(gid !== undefined ? { runAsGroup: gid } : {}),
                  seccompProfile: { type: 'RuntimeDefault' },
                },
                containers: [
                  {
                    name: 'tofu',
                    image: opts.image,
                    command: ['/bin/sh', '-c', session.command],
                    securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } },
                    volumeMounts: [
                      { name: 'work', mountPath: opts.remoteRoot },
                      { name: 'tmp', mountPath: '/tmp' },
                    ],
                    ...(opts.resources ? { resources: opts.resources } : {}),
                  },
                ],
                volumes: [
                  { name: 'work', persistentVolumeClaim: { claimName: opts.workClaim } },
                  { name: 'tmp', emptyDir: {} },
                ],
              },
            },
          },
        };
        const res = await opts.request('POST', base, job);
        if (res.status >= 300) return session.collect(commands.length, { kind: 'failed', reason: `Kubernetes did not create the Job (${res.status}): ${apiMessage(res.body)}` });
        created = true;

        let kind: TofuExecResult['kind'] = 'failed';
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          if (stack.signal?.aborted || Date.now() > deadline) {
            kind = stack.signal?.aborted ? 'cancelled' : 'timeout';
            return session.collect(commands.length, { kind });
          }
          const got = await opts.request('GET', `${base}/${name}`);
          const status = (got.body as JobStatus).status;
          if (got.status === 404) return session.collect(commands.length, { kind, reason: 'The Job was deleted.' });
          if (status?.succeeded) return session.collect(commands.length, { kind });
          const failed = status?.conditions?.find((c) => c.type === 'Failed' && c.status === 'True');
          if (status?.failed || failed) return session.collect(commands.length, { kind: failed?.reason === 'DeadlineExceeded' ? 'timeout' : kind, reason: failed?.message ?? failed?.reason });
          const pods = await opts.request('GET', `/api/v1/namespaces/${encodeURIComponent(opts.namespace)}/pods?labelSelector=${encodeURIComponent(`job-name=${name}`)}`);
          const waiting = (pods.body as PodList).items?.flatMap((p) => p.status?.containerStatuses ?? []).find((c) => STUCK.has(c.state?.waiting?.reason ?? ''))?.state?.waiting;
          if (waiting) return session.collect(commands.length, { kind, reason: `${waiting.reason}: ${waiting.message ?? ''}`.trim() });
          await pause(pollMs, stack.signal);
        }
      } finally {
        // Deleting the Job stops its pod when it is still running (cancel, timeout, stuck pod).
        if (created) await opts.request('DELETE', `${base}/${name}?propagationPolicy=Background`).catch(() => {});
        await session.clean(commands.length);
      }
    },
  };
}

function apiMessage(body: unknown): string {
  if (body && typeof body === 'object' && 'message' in body) return String((body as { message: unknown }).message);
  return String(body).slice(0, 300);
}
