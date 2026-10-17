// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

export interface TofuRunnerOptions {
  /** Pinned OpenTofu image, e.g. ghcr.io/opentofu/opentofu:1.12.7. */
  image: string;
  /**
   * Host directory holding the module library, mounted read-only at /modules. Omit when the
   * runner image already contains the modules at /modules (containerized worker).
   */
  modulesDir?: string;
  /** Directory (as seen by this process) for per-state working directories. */
  workRoot: string;
  /**
   * Docker volume mounted at `workRoot` in this process. Required when this process runs in a
   * container itself: the Docker daemon cannot see paths inside our container, but it can mount
   * the same named volume into the runner.
   */
  workVolume?: string;
  /** Docker volume shared as the provider plugin cache. */
  pluginCacheVolume: string;
  /** Docker network to join (e.g. to reach a local emulator). */
  network?: string;
  dockerBin?: string;
  /** Hard ceiling for a single command. */
  timeoutMs?: number;
}

export interface TofuStack {
  /** Stable identity of this state; also names the working directory. */
  stateKey: string;
  /** Complete root configuration in OpenTofu JSON syntax (terraform/provider/module/output). */
  config: Record<string, unknown>;
  /** Environment for the container (credentials). Passed by name, never on the command line. */
  env: Record<string, string>;
  signal?: AbortSignal;
  onLog?: (line: TofuLogLine) => void;
}

export interface TofuLogLine {
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface ApplyResult {
  outputs: Record<string, unknown>;
  changes: { add: number; change: number; remove: number };
}

export interface PlanResult {
  changes: { add: number; change: number; remove: number };
  /** Per address; action is OpenTofu's: create | update | delete | replace | read | noop. */
  actions: { address: string; action: string }[];
}

export class TofuError extends Error {
  constructor(
    message: string,
    readonly diagnostics: string[],
    readonly kind: 'timeout' | 'cancelled' | 'failed',
  ) {
    super(message);
    this.name = 'TofuError';
  }
}

export interface DriftChange {
  address: string;
  action: string;
  /** Top-level attributes whose value changed outside OpenTofu (names only, never values). */
  attributes: string[];
}

interface ShownPlan {
  resource_drift?: { address: string; change: { actions: string[]; before: Record<string, unknown> | null; after: Record<string, unknown> | null } }[];
}

/**
 * Comparable form of an attribute value. Providers flip between null, {} and [] for "nothing"
 * (e.g. `tags` under default_tags) and return sets in any order; neither is a real change.
 */
function normalize(v: unknown): unknown {
  if (v === null || v === undefined || v === '') return null;
  if (Array.isArray(v)) {
    const items = v.map(normalize).filter((x) => x !== null);
    if (items.length === 0) return null;
    return items.every((x) => typeof x !== 'object') ? [...items].sort() : items;
  }
  if (typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => [k, normalize(x)] as const)
      .filter(([, x]) => x !== null)
      .sort(([a], [b]) => a.localeCompare(b));
    return entries.length === 0 ? null : Object.fromEntries(entries);
  }
  return v;
}

/** Attribute-level view of a refresh-only plan (`tofu show -json`). */
export function driftChanges(plan: ShownPlan): DriftChange[] {
  return (plan.resource_drift ?? []).flatMap((d) => {
    const before = d.change.before ?? {};
    const after = d.change.after ?? {};
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
    const attributes = keys.filter((k) => JSON.stringify(normalize(before[k])) !== JSON.stringify(normalize(after[k]))).sort();
    const action = d.change.actions.includes('delete') ? 'delete' : d.change.actions.join('-') || 'update';
    // Only representation changed (see normalize): not drift.
    if (action !== 'delete' && attributes.length === 0) return [];
    return [{ address: d.address, action, attributes }];
  });
}

interface JsonLine {
  '@level'?: string;
  '@message'?: string;
  type?: string;
  changes?: { add: number; change: number; remove: number; operation?: string };
  change?: { resource?: { addr: string }; action?: string };
  diagnostic?: { severity: string; summary: string; detail?: string };
}

/**
 * Runs OpenTofu in an isolated, throwaway container per command (spec §44): the control plane
 * never executes IaC in-process, the module library is mounted read-only, and credentials reach
 * the container only as environment variables for that one run.
 */
export class TofuRunner {
  private readonly docker: string;
  /** Longest a single OpenTofu command may run before it is stopped. */
  readonly timeoutMs: number;

  constructor(private readonly opts: TofuRunnerOptions) {
    this.docker = opts.dockerBin ?? 'docker';
    this.timeoutMs = opts.timeoutMs ?? 45 * 60 * 1000;
  }

  async apply(stack: TofuStack): Promise<ApplyResult> {
    const dir = await this.prepare(stack);
    await this.run(stack, dir, ['init', '-input=false', '-no-color'], false);
    const lines = await this.run(stack, dir, ['apply', '-auto-approve', '-input=false', '-json'], true);
    const summary = lines.find((l) => l.type === 'change_summary')?.changes ?? { add: 0, change: 0, remove: 0 };
    return { outputs: await this.outputs(stack, dir), changes: { add: summary.add, change: summary.change, remove: summary.remove } };
  }

  /**
   * Speculative plan (no lock, no apply): what OpenTofu would change, per resource address.
   * Used to show real changes before approval and to flag destructive actions.
   */
  async plan(stack: TofuStack): Promise<PlanResult> {
    const dir = await this.prepare(stack);
    await this.run(stack, dir, ['init', '-input=false', '-no-color'], false);
    const lines = await this.run(stack, dir, ['plan', '-input=false', '-json', '-lock=false'], true);
    const summary = lines.find((l) => l.type === 'change_summary')?.changes ?? { add: 0, change: 0, remove: 0 };
    const actions = lines
      .filter((l) => l.type === 'planned_change' && l.change?.resource?.addr)
      .map((l) => ({ address: l.change!.resource!.addr, action: l.change!.action ?? 'unknown' }));
    return { changes: { add: summary.add, change: summary.change, remove: summary.remove }, actions };
  }

  /**
   * Refresh-only plan: what changed in the real infrastructure since the last apply (edited or
   * deleted outside OpenTofu). Configuration changes (e.g. a newer module) are not drift and do
   * not appear here.
   */
  async drift(stack: TofuStack): Promise<DriftChange[]> {
    const dir = await this.prepare(stack);
    await this.run(stack, dir, ['init', '-input=false', '-no-color'], false);
    const planFile = 'drift.tfplan';
    try {
      await this.run(stack, dir, ['plan', '-input=false', '-json', '-lock=false', '-refresh-only', `-out=${planFile}`], true);
      const shown = await this.exec(stack, dir, ['show', '-json', planFile]);
      if (shown.code !== 0) throw new TofuError(`tofu show failed: ${shown.stderr.slice(0, 300)}`, [], shown.kind);
      return driftChanges(JSON.parse(shown.stdout) as ShownPlan);
    } finally {
      // The saved plan holds attribute values (possibly sensitive): never leave it behind.
      await rm(join(dir, planFile), { force: true });
    }
  }

  async destroy(stack: TofuStack): Promise<void> {
    const dir = await this.prepare(stack);
    await this.run(stack, dir, ['init', '-input=false', '-no-color'], false);
    await this.run(stack, dir, ['destroy', '-auto-approve', '-input=false', '-json'], true);
    await rm(dir, { recursive: true, force: true });
  }

  private async outputs(stack: TofuStack, dir: string): Promise<Record<string, unknown>> {
    const raw = await this.exec(stack, dir, ['output', '-json']);
    const parsed = JSON.parse(raw.stdout || '{}') as Record<string, { value: unknown; sensitive?: boolean }>;
    // Sensitive outputs are dropped: the control plane stores references, never secret values.
    return Object.fromEntries(Object.entries(parsed).filter(([, o]) => !o.sensitive).map(([k, o]) => [k, o.value]));
  }

  private async prepare(stack: TofuStack): Promise<string> {
    const dir = join(this.opts.workRoot, createHash('sha256').update(stack.stateKey).digest('hex').slice(0, 24));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'main.tf.json'), JSON.stringify(stack.config, null, 2));
    return dir;
  }

  private async run(stack: TofuStack, dir: string, args: string[], json: boolean): Promise<JsonLine[]> {
    const result = await this.exec(stack, dir, args);
    const lines: JsonLine[] = [];
    const diagnostics: string[] = [];
    for (const raw of result.stdout.split('\n')) {
      if (!raw.trim()) continue;
      if (!json) continue;
      let line: JsonLine;
      try {
        line = JSON.parse(raw) as JsonLine;
      } catch {
        continue;
      }
      lines.push(line);
      if (line.type === 'diagnostic' && line.diagnostic) {
        const d = `${line.diagnostic.summary}${line.diagnostic.detail ? `: ${line.diagnostic.detail}` : ''}`;
        if (line.diagnostic.severity === 'error') diagnostics.push(d);
        stack.onLog?.({ level: line.diagnostic.severity === 'error' ? 'error' : 'warn', message: d });
      } else if (line.type === 'apply_complete' || line.type === 'apply_errored' || line.type === 'change_summary') {
        stack.onLog?.({ level: line.type === 'apply_errored' ? 'error' : 'info', message: line['@message'] ?? '' });
      }
    }
    if (result.code !== 0) {
      if (!json) diagnostics.push(...result.stderr.split('\n').filter((l) => /error/i.test(l)).slice(0, 5));
      const message = diagnostics[0] ?? result.stderr.trim().split('\n').slice(-3).join(' ') ?? `tofu ${args[0]} failed`;
      throw new TofuError(`tofu ${args[0]} failed: ${message}`.slice(0, 1500), diagnostics, result.kind);
    }
    return lines;
  }

  private exec(stack: TofuStack, dir: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string; kind: 'timeout' | 'cancelled' | 'failed' }> {
    const name = `orkstage-tofu-${randomBytes(6).toString('hex')}`;
    const work = this.opts.workVolume
      ? ['-v', `${this.opts.workVolume}:/workspace`, '-w', `/workspace/${basename(dir)}`]
      : ['-v', `${dir}:/work`, '-w', '/work'];
    const dockerArgs = [
      'run', '--rm', '--name', name,
      ...(this.opts.network ? ['--network', this.opts.network] : []),
      ...work,
      ...(this.opts.modulesDir ? ['-v', `${this.opts.modulesDir}:/modules:ro`] : []),
      '-v', `${this.opts.pluginCacheVolume}:/plugins`,
      '-e', 'TF_PLUGIN_CACHE_DIR=/plugins',
      '-e', 'TF_IN_AUTOMATION=1',
      ...Object.keys(stack.env).flatMap((k) => ['-e', k]),
      this.opts.image,
      ...args,
    ];
    return new Promise((resolve) => {
      const child = spawn(this.docker, dockerArgs, { env: { ...process.env, ...stack.env }, windowsHide: true });
      let stdout = '';
      let stderr = '';
      let kind: 'timeout' | 'cancelled' | 'failed' = 'failed';
      const kill = (why: 'timeout' | 'cancelled') => {
        kind = why;
        spawn(this.docker, ['kill', name], { windowsHide: true }).on('error', () => {});
      };
      const timer = setTimeout(() => kill('timeout'), this.timeoutMs);
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
    });
  }
}
