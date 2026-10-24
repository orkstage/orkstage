// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { TofuStack } from './runner.js';

export interface TofuExecResult {
  code: number;
  stdout: string;
  stderr: string;
  kind: 'timeout' | 'cancelled' | 'failed';
}

/** Tests only: runs one OpenTofu command. */
export type TofuExec = (stack: TofuStack, dir: string, args: string[]) => Promise<TofuExecResult>;

/**
 * Where OpenTofu runs (ADR 0016). `dir` is the work directory as this process sees it; the runner
 * sees the same directory through a shared volume. Commands run in order and stop after the first
 * that fails, so the result list is shorter than the command list when one failed.
 */
export interface TofuExecutor {
  run(stack: TofuStack, dir: string, commands: string[][], timeoutMs: number): Promise<TofuExecResult[]>;
}

/** One command at a time, through `exec`. */
export function sequential(exec: (stack: TofuStack, dir: string, args: string[], timeoutMs: number) => Promise<TofuExecResult>): TofuExecutor {
  return {
    async run(stack, dir, commands, timeoutMs) {
      const results: TofuExecResult[] = [];
      for (const args of commands) {
        const result = await exec(stack, dir, args, timeoutMs);
        results.push(result);
        if (result.code !== 0) break;
      }
      return results;
    },
  };
}

export interface DockerExecutorOptions {
  /** Pinned OpenTofu image, e.g. ghcr.io/opentofu/opentofu:1.13.2. */
  image: string;
  /**
   * Host directory holding the module library, mounted read-only at /modules. Omit when the
   * runner image already contains the modules at /modules (containerized worker).
   */
  modulesDir?: string;
  /**
   * Docker volume mounted at the work root in this process. Required when this process runs in a
   * container itself: the Docker daemon cannot see paths inside our container, but it can mount
   * the same named volume into the runner.
   */
  workVolume?: string;
  /** Docker volume shared as the provider plugin cache. */
  pluginCacheVolume: string;
  /** Docker network to join (e.g. to reach a local emulator). */
  network?: string;
  dockerBin?: string;
}

/**
 * A throwaway container per command on the local Docker daemon (spec §44). Needs the Docker socket,
 * which gives control of the host: the ECS and Kubernetes executors avoid it.
 */
export function dockerExecutor(opts: DockerExecutorOptions): TofuExecutor {
  const docker = opts.dockerBin ?? 'docker';
  return sequential(
    (stack, dir, args, timeoutMs) =>
      new Promise((resolve) => {
        const name = `orkstage-tofu-${randomBytes(6).toString('hex')}`;
        const work = opts.workVolume ? ['-v', `${opts.workVolume}:/workspace`, '-w', `/workspace/${basename(dir)}`] : ['-v', `${dir}:/work`, '-w', '/work'];
        const dockerArgs = [
          'run', '--rm', '--name', name,
          ...(opts.network ? ['--network', opts.network] : []),
          ...work,
          ...(opts.modulesDir ? ['-v', `${opts.modulesDir}:/modules:ro`] : []),
          '-v', `${opts.pluginCacheVolume}:/plugins`,
          '-e', 'TF_PLUGIN_CACHE_DIR=/plugins',
          '-e', 'TF_IN_AUTOMATION=1',
          ...Object.keys(stack.env).flatMap((k) => ['-e', k]),
          opts.image,
          ...args,
        ];
        const child = spawn(docker, dockerArgs, { env: { ...process.env, ...stack.env }, windowsHide: true });
        let stdout = '';
        let stderr = '';
        let kind: TofuExecResult['kind'] = 'failed';
        const kill = (why: 'timeout' | 'cancelled') => {
          kind = why;
          spawn(docker, ['kill', name], { windowsHide: true }).on('error', () => {});
        };
        const timer = setTimeout(() => kill('timeout'), timeoutMs);
        const onAbort = () => kill('cancelled');
        stack.signal?.addEventListener('abort', onAbort, { once: true });
        child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
        child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
        child.on('error', (err) => {
          stderr += err.message;
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          stack.signal?.removeEventListener('abort', onAbort);
          resolve({ code: code ?? 1, stdout, stderr, kind });
        });
      }),
  );
}

/** Work directory names the runner creates: a hash, plus the purpose for previews and drift scans. */
const WORK_DIR = /^[0-9a-f]{24}(-preview|-drift)?$/;
const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/**
 * A session of commands in a remote runner (ECS task, Kubernetes Job) that shares the work
 * directory through a volume. Credentials go in a file only the session's user can read, which
 * the session deletes as soon as it has read it: they never appear in the task or Job definition,
 * the API call that starts it, or the audit trail of the orchestrator. Outputs and exit codes come
 * back as files in the same directory.
 */
export class RemoteSession {
  readonly id = randomBytes(8).toString('hex');
  /** The work directory as the runner sees it. */
  readonly remoteDir: string;
  private readonly prefix: string;

  constructor(
    private readonly dir: string,
    /** Mount point of the shared work volume in the runner. */
    remoteRoot: string,
    /** Provider plugin cache directory in the runner (on the shared volume, so it is reused). */
    private readonly pluginCache = `${remoteRoot}/.plugin-cache`,
  ) {
    const name = basename(dir);
    if (!WORK_DIR.test(name)) throw new Error(`Unexpected OpenTofu work directory: ${name}`);
    this.prefix = `.orkstage-${this.id}`;
    this.remoteDir = `${remoteRoot}/${name}`;
  }

  /** The shell command the runner container executes (`/bin/sh -c <command>`). */
  get command(): string {
    return `cd ${this.remoteDir} && exec /bin/sh ./${this.prefix}.sh`;
  }

  /** Writes the credentials file and the session script. */
  async write(stack: TofuStack, commands: string[][]): Promise<void> {
    const env = Object.entries(stack.env).map(([k, v]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`Invalid environment variable name: ${k}`);
      return `export ${k}=${quote(v)}\n`;
    });
    await writeFile(join(this.dir, `${this.prefix}.env`), env.join(''), { mode: 0o600 });
    const p = `./${this.prefix}`;
    const steps = commands.map(
      (args, i) => `tofu ${args.map(quote).join(' ')} >${p}.${i}.out 2>${p}.${i}.err; c=$?; echo $c >${p}.${i}.code; [ $c -eq 0 ] || exit 0\n`,
    );
    const script = [
      `. ${p}.env\n`,
      `rm -f ${p}.env\n`,
      `export HOME=/tmp TF_IN_AUTOMATION=1 TF_PLUGIN_CACHE_DIR=${quote(this.pluginCache)}\n`,
      'mkdir -p "$TF_PLUGIN_CACHE_DIR"\n',
      ...steps,
    ].join('');
    await writeFile(join(this.dir, `${this.prefix}.sh`), script, { mode: 0o600 });
  }

  /**
   * The results of the commands that ran. When the runner stopped before a command finished (it
   * did not start, was stopped, or timed out), the last result says why.
   */
  async collect(count: number, stopped: { kind: TofuExecResult['kind']; reason?: string }): Promise<TofuExecResult[]> {
    const results: TofuExecResult[] = [];
    for (let i = 0; i < count; i++) {
      const code = await readFile(join(this.dir, `${this.prefix}.${i}.code`), 'utf8').catch(() => null);
      if (code === null) break;
      const [stdout, stderr] = await Promise.all(['out', 'err'].map((s) => readFile(join(this.dir, `${this.prefix}.${i}.${s}`), 'utf8').catch(() => '')));
      results.push({ code: Number(code.trim()) || 0, stdout: stdout!, stderr: stderr!, kind: 'failed' });
      if (Number(code.trim()) !== 0) return results;
    }
    if (results.length < count) {
      const why = stopped.kind === 'timeout' ? 'The OpenTofu runner timed out.' : stopped.kind === 'cancelled' ? 'The OpenTofu runner was cancelled.' : 'The OpenTofu runner stopped before finishing.';
      results.push({ code: 1, stdout: '', stderr: `${why}${stopped.reason ? ` ${stopped.reason}` : ''}`, kind: stopped.kind });
    }
    return results;
  }

  /** Removes every file of this session (the credentials file first, in case the runner never started). */
  async clean(count: number): Promise<void> {
    const files = [`${this.prefix}.env`, `${this.prefix}.sh`, ...Array.from({ length: count }, (_, i) => ['out', 'err', 'code'].map((s) => `${this.prefix}.${i}.${s}`)).flat()];
    for (const f of files) await rm(join(this.dir, f), { force: true });
  }
}

/** Waits `ms`, or less when `signal` aborts. */
export function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}
