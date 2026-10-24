// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ecsExecutor } from './ecs.js';
import type { TofuExecutor } from './executor.js';
import { type KubeRequest, kubernetesExecutor } from './kubernetes.js';
import { TofuRunner, type TofuStack } from './runner.js';

const hasShell = spawnSync('sh', ['-c', 'exit 0']).status === 0;
const SECRET = `s3cr'et $HOME "value"`;

/**
 * A work root with a fake `tofu` on PATH: it prints its arguments and one environment variable,
 * and fails `apply` when asked to. Stands in for the runner image.
 */
function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'tofu-remote-'));
  const bin = join(root, '.bin');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'tofu'),
    '#!/bin/sh\nif [ "$1" = apply ] && [ "$FAIL_APPLY" = 1 ]; then echo "apply broke" >&2; exit 3; fi\necho "{\\"args\\":\\"$*\\",\\"secret\\":\\"$(printf %s "$AWS_SECRET_ACCESS_KEY" | wc -c)\\"}"\n',
  );
  chmodSync(join(bin, 'tofu'), 0o755);
  const dir = join(root, 'a'.repeat(24));
  mkdirSync(dir);
  const remoteRoot = root.replaceAll('\\', '/');
  /** What the runner container does with the command it was given. */
  const runRemote = (command: string) => spawnSync('sh', ['-c', command], { env: { ...process.env, PATH: `${bin.replaceAll('\\', '/')}:${process.env.PATH}` }, encoding: 'utf8' });
  return { root, dir, remoteRoot, runRemote };
}

const stack = (env: Record<string, string> = {}, signal?: AbortSignal): TofuStack => ({ stateKey: 's', config: {}, env: { AWS_SECRET_ACCESS_KEY: SECRET, ...env }, signal });
const COMMANDS = [['init'], ['validate'], ['apply', '-json'], ['output', '-json']];

describe.skipIf(!hasShell)('ECS executor (ADR 0016)', () => {
  function fakeEcs(w: ReturnType<typeof workspace>, behaviour: { start?: boolean; never?: boolean } = {}) {
    const sent: { name: string; input: Record<string, unknown> }[] = [];
    const client = {
      send: (async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
        const name = cmd.constructor.name;
        sent.push({ name, input: cmd.input });
        if (name === 'RunTaskCommand') {
          if (behaviour.start === false) return { tasks: [], failures: [{ reason: 'RESOURCE:MEMORY' }] };
          if (!behaviour.never) {
            const overrides = cmd.input.overrides as { containerOverrides: { command: string[] }[] };
            w.runRemote(overrides.containerOverrides[0]!.command[0]!);
          }
          return { tasks: [{ taskArn: 'arn:task/1' }] };
        }
        if (name === 'DescribeTasksCommand') {
          return behaviour.never ? { tasks: [{ lastStatus: 'RUNNING' }] } : { tasks: [{ lastStatus: 'STOPPED', stoppedReason: 'Essential container in task exited', containers: [{ name: 'tofu' }] }] };
        }
        return {};
      }) as never,
    };
    const executor = ecsExecutor({ client, cluster: 'c', taskDefinition: 'orkstage-tofu', container: 'tofu', subnets: ['subnet-1'], securityGroups: ['sg-1'], remoteRoot: w.remoteRoot, pollMs: 5, stopGraceMs: 50 });
    return { executor, sent };
  }

  it('runs the whole session in one task and never puts credentials in the RunTask call', async () => {
    const w = workspace();
    const { executor, sent } = fakeEcs(w);
    const results = await executor.run(stack(), w.dir, COMMANDS, 60_000);
    expect(results.map((r) => r.code)).toEqual([0, 0, 0, 0]);
    expect(JSON.parse(results[2]!.stdout)).toEqual({ args: 'apply -json', secret: String(SECRET.length) });
    expect(sent.filter((s) => s.name === 'RunTaskCommand')).toHaveLength(1);
    expect(JSON.stringify(sent)).not.toContain('s3cr');
    const run = sent[0]!.input as { networkConfiguration: { awsvpcConfiguration: { assignPublicIp: string } } };
    expect(run.networkConfiguration.awsvpcConfiguration.assignPublicIp).toBe('DISABLED');
    // Credentials file, script and outputs are gone.
    expect(readdirSync(w.dir)).toEqual([]);
  });

  it('stops at the first failing command', async () => {
    const w = workspace();
    const { executor } = fakeEcs(w);
    const results = await executor.run(stack({ FAIL_APPLY: '1' }), w.dir, COMMANDS, 60_000);
    expect(results.map((r) => r.code)).toEqual([0, 0, 3]);
    expect(results[2]!.stderr).toContain('apply broke');
  });

  it('reports a task ECS could not start', async () => {
    const w = workspace();
    const { executor } = fakeEcs(w, { start: false });
    const [result] = await executor.run(stack(), w.dir, COMMANDS, 60_000);
    expect(result).toMatchObject({ code: 1, kind: 'failed' });
    expect(result!.stderr).toMatch(/did not start the task: RESOURCE:MEMORY/);
    expect(readdirSync(w.dir)).toEqual([]);
  });

  it('stops the task when the deployment is cancelled', async () => {
    const w = workspace();
    const { executor, sent } = fakeEcs(w, { never: true });
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 20);
    // The fake task never stops: the executor gives up after the stop grace period.
    const results = await executor.run(stack({}, abort.signal), w.dir, COMMANDS, 60_000);
    expect(sent.find((s) => s.name === 'StopTaskCommand')!.input).toMatchObject({ task: 'arn:task/1', reason: 'OrkStage: cancelled' });
    expect(results.at(-1)).toMatchObject({ code: 1, kind: 'cancelled' });
    expect(results.at(-1)!.stderr).toMatch(/cancelled\. Task arn:task\/1 did not stop in time/);
    expect(readdirSync(w.dir)).toEqual([]);
  });
});

describe.skipIf(!hasShell)('Kubernetes executor (ADR 0016)', () => {
  function fakeKube(w: ReturnType<typeof workspace>, behaviour: { stuck?: boolean } = {}) {
    const calls: { method: string; path: string; body?: unknown }[] = [];
    const request: KubeRequest = async (method, path, body) => {
      calls.push({ method, path, body });
      if (method === 'POST') {
        const job = body as { spec: { template: { spec: { containers: { command: string[] }[] } } } };
        if (!behaviour.stuck) w.runRemote(job.spec.template.spec.containers[0]!.command[2]!);
        return { status: 201, body: {} };
      }
      if (method === 'GET' && path.includes('/jobs/')) return { status: 200, body: behaviour.stuck ? { status: { active: 1 } } : { status: { succeeded: 1 } } };
      if (method === 'GET') return { status: 200, body: { items: [{ status: { containerStatuses: [{ state: { waiting: { reason: 'ImagePullBackOff', message: 'pull access denied' } } }] } }] } };
      return { status: 200, body: {} };
    };
    const executor = kubernetesExecutor({ request, namespace: 'orkstage', image: 'ghcr.io/orkstage/tofu-runner:1', workClaim: 'tofu-work', remoteRoot: w.remoteRoot, runAsUser: 10001, runAsGroup: 10001, pollMs: 5 });
    return { executor, calls };
  }

  it('runs the session as a locked down Job without credentials in the manifest, then deletes it', async () => {
    const w = workspace();
    const { executor, calls } = fakeKube(w);
    const results = await executor.run(stack(), w.dir, COMMANDS, 600_000);
    expect(results.map((r) => r.code)).toEqual([0, 0, 0, 0]);
    const job = calls[0]!.body as { spec: { backoffLimit: number; activeDeadlineSeconds: number; template: { spec: Record<string, unknown> & { containers: Record<string, unknown>[] } } } };
    expect(JSON.stringify(job)).not.toContain('s3cr');
    expect(job.spec).toMatchObject({ backoffLimit: 0, activeDeadlineSeconds: 600 });
    expect(job.spec.template.spec).toMatchObject({
      restartPolicy: 'Never',
      automountServiceAccountToken: false,
      securityContext: { runAsUser: 10001, runAsGroup: 10001, runAsNonRoot: true },
      volumes: [{ name: 'work', persistentVolumeClaim: { claimName: 'tofu-work' } }, { name: 'tmp', emptyDir: {} }],
    });
    expect(job.spec.template.spec.containers[0]).toMatchObject({ securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } } });
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE' });
    expect(calls.at(-1)!.path).toMatch(/\/jobs\/orkstage-tofu-[0-9a-f]{16}\?propagationPolicy=Background$/);
    expect(readdirSync(w.dir)).toEqual([]);
  });

  it('fails fast when the runner image cannot be pulled', async () => {
    const w = workspace();
    const { executor, calls } = fakeKube(w, { stuck: true });
    const [result] = await executor.run(stack(), w.dir, COMMANDS, 600_000);
    expect(result!.stderr).toMatch(/ImagePullBackOff: pull access denied/);
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE' });
    expect(existsSync(w.dir) && readdirSync(w.dir)).toEqual([]);
  });
});

describe('TofuRunner sessions', () => {
  it('runs init, validate and the operation as one session on the executor', async () => {
    const sessions: string[][][] = [];
    const executor: TofuExecutor = {
      async run(_stack, _dir, commands) {
        sessions.push(commands);
        return commands.map((c) => ({ code: 0, stdout: c[0] === 'validate' ? '{"valid":true}' : c[0] === 'output' ? '{"url":{"value":"https://x"}}' : '', stderr: '', kind: 'failed' as const }));
      },
    };
    const runner = new TofuRunner({ workRoot: mkdtempSync(join(tmpdir(), 'tofu-session-')), executor });
    const result = await runner.apply({ stateKey: 's', config: {}, env: {} });
    expect(result.outputs).toEqual({ url: 'https://x' });
    expect(sessions.map((s) => s.map((c) => c[0]))).toEqual([['init', 'validate', 'apply', 'output']]);
  });

  it('needs an executor or Docker settings', () => {
    expect(() => new TofuRunner({ workRoot: tmpdir() })).toThrow(/needs an executor/);
  });
});
