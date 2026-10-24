// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { type DockerExecutorOptions, dockerExecutor, sequential, type TofuExec, type TofuExecResult, type TofuExecutor } from './executor.js';

export interface TofuRunnerOptions extends Partial<DockerExecutorOptions> {
  /** Directory (as seen by this process) for per-state working directories. */
  workRoot: string;
  /** Hard ceiling for one OpenTofu session (init, validate and the operation's commands). */
  timeoutMs?: number;
  /** Where OpenTofu runs (ADR 0016); without it, a container per command on the local Docker daemon. */
  executor?: TofuExecutor;
  /** Tests only: runs one OpenTofu command instead of a container. */
  exec?: TofuExec;
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
  /**
   * The deployment's plan for this state (item 5 of open-items: what is approved is what is
   * applied). `plan` saves it; `apply` applies exactly that file. When the configuration or the
   * state changed in between, a strict plan (production) fails the step; otherwise the apply plans
   * again and says so.
   */
  savedPlan?: { id: string; strict: boolean };
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

const planFile = (id: string) => `deploy-${id}.tfplan`;
const planHashFile = (id: string) => `deploy-${id}.sha256`;
/** What a saved plan was made from: applying it to another configuration is refused. */
const configHash = (config: Record<string, unknown>) => createHash('sha256').update(JSON.stringify(config)).digest('hex');

interface JsonLine {
  '@level'?: string;
  '@message'?: string;
  type?: string;
  changes?: { add: number; change: number; remove: number; operation?: string };
  change?: { resource?: { addr: string }; action?: string };
  diagnostic?: { severity: string; summary: string; detail?: string };
}

const INIT = ['init', '-input=false', '-no-color'];
const VALIDATE = ['validate', '-json', '-no-color'];
const OUTPUT = ['output', '-json'];
const APPLY = ['apply', '-auto-approve', '-input=false', '-json'];

/**
 * Runs OpenTofu in an isolated, throwaway runner (spec §44): the control plane never executes IaC
 * in-process, the module library is read-only, and credentials reach the runner only for that one
 * run. Each operation is one session (init, validate, then its commands) on an executor: a
 * container per command on Docker, one task or Job per session on ECS and Kubernetes (ADR 0016).
 */
export class TofuRunner {
  private readonly executor: TofuExecutor;
  /** Longest an OpenTofu session may run before it is stopped. */
  readonly timeoutMs: number;

  constructor(private readonly opts: TofuRunnerOptions) {
    this.timeoutMs = opts.timeoutMs ?? 45 * 60 * 1000;
    const { exec, executor, image, pluginCacheVolume } = opts;
    if (exec) this.executor = sequential((stack, dir, args) => exec(stack, dir, args));
    else if (executor) this.executor = executor;
    else if (image && pluginCacheVolume) this.executor = dockerExecutor({ ...opts, image, pluginCacheVolume });
    else throw new Error('TofuRunner needs an executor, or an image and a plugin cache volume for Docker.');
  }

  async apply(stack: TofuStack): Promise<ApplyResult> {
    const dir = await this.prepare(stack, 'main');
    const saved = stack.savedPlan ? await this.takeSavedPlan(stack, dir) : null;
    let results: TofuExecResult[];
    let lines: JsonLine[];
    if (saved) {
      try {
        results = await this.session(stack, dir, [['apply', '-input=false', '-json', saved], OUTPUT]);
        lines = this.parse(stack, dir, APPLY, results[0]!, true);
      } catch (err) {
        if (!(err instanceof TofuError) || !/stale/i.test(err.message)) throw err;
        if (stack.savedPlan!.strict) {
          throw new TofuError('The infrastructure changed after the plan was approved, so it was not applied. Deploy again to plan and approve the current changes.', err.diagnostics, 'failed');
        }
        stack.onLog?.({ level: 'warn', message: 'The saved plan was outdated (the state changed since it was made); planning and applying again.' });
        results = await this.session(stack, dir, [APPLY, OUTPUT]);
        lines = this.parse(stack, dir, APPLY, results[0]!, true);
      } finally {
        await this.dropSavedPlan(stack, dir);
      }
    } else {
      results = await this.session(stack, dir, [APPLY, OUTPUT]);
      lines = this.parse(stack, dir, APPLY, results[0]!, true);
    }
    const summary = lines.find((l) => l.type === 'change_summary')?.changes ?? { add: 0, change: 0, remove: 0 };
    return { outputs: this.outputs(results[1]), changes: { add: summary.add, change: summary.change, remove: summary.remove } };
  }

  /**
   * Plan of what OpenTofu would change, per resource address. With `savedPlan` (a deployment's plan
   * phase) the plan is locked and saved for the apply; without it, it is speculative: no lock, its
   * own working directory, nothing kept.
   */
  async plan(stack: TofuStack): Promise<PlanResult> {
    const dir = await this.prepare(stack, stack.savedPlan ? 'main' : 'preview');
    const args = stack.savedPlan
      ? ['plan', '-input=false', '-json', `-out=${planFile(stack.savedPlan.id)}`]
      : ['plan', '-input=false', '-json', '-lock=false'];
    const [result] = await this.session(stack, dir, [args]);
    const lines = this.parse(stack, dir, args, result!, true);
    if (stack.savedPlan) await writeFile(join(dir, planHashFile(stack.savedPlan.id)), configHash(stack.config));
    const summary = lines.find((l) => l.type === 'change_summary')?.changes ?? { add: 0, change: 0, remove: 0 };
    const actions = lines
      .filter((l) => l.type === 'planned_change' && l.change?.resource?.addr)
      .map((l) => ({ address: l.change!.resource!.addr, action: l.change!.action ?? 'unknown' }));
    return { changes: { add: summary.add, change: summary.change, remove: summary.remove }, actions };
  }

  /**
   * Refresh-only plan: what changed in the real infrastructure since the last apply (edited or
   * deleted outside OpenTofu). Configuration changes (e.g. a newer module) are not drift and do
   * not appear here. Runs in its own working directory, so a scan never touches a deployment's.
   */
  async drift(stack: TofuStack): Promise<DriftChange[]> {
    const dir = await this.prepare(stack, 'drift');
    const file = 'drift.tfplan';
    try {
      const plan = ['plan', '-input=false', '-json', '-lock=false', '-refresh-only', `-out=${file}`];
      const [planned, shown] = await this.session(stack, dir, [plan, ['show', '-json', file]]);
      this.parse(stack, dir, plan, planned!, true);
      if (shown?.code !== 0) throw new TofuError(`tofu show failed: ${shown?.stderr.slice(0, 300) ?? ''}`, [], shown?.kind ?? 'failed');
      return driftChanges(JSON.parse(shown.stdout) as ShownPlan);
    } finally {
      // The saved plan holds attribute values (possibly sensitive): never leave it behind.
      await rm(join(dir, file), { force: true });
    }
  }

  async destroy(stack: TofuStack): Promise<void> {
    const dir = await this.prepare(stack, 'main');
    const args = ['destroy', '-auto-approve', '-input=false', '-json'];
    const [result] = await this.session(stack, dir, [args]);
    this.parse(stack, dir, args, result!, true);
    await rm(dir, { recursive: true, force: true });
    for (const purpose of ['preview', 'drift'] as const) await rm(this.dirFor(stack, purpose), { recursive: true, force: true });
  }

  /**
   * `init`, `validate`, then `commands`, in one session: a configuration error stops before any
   * plan or apply. Returns the results of `commands`; the first one is always there.
   */
  private async session(stack: TofuStack, dir: string, commands: string[][]): Promise<TofuExecResult[]> {
    const [init, validate, ...rest] = await this.executor.run(stack, dir, [INIT, VALIDATE, ...commands], this.timeoutMs);
    this.parse(stack, dir, INIT, init!, false);
    this.checkValid(validate!);
    return rest;
  }

  private checkValid(res: TofuExecResult): void {
    let report: { valid?: boolean; diagnostics?: { severity: string; summary: string; detail?: string }[] } = {};
    try {
      report = JSON.parse(res.stdout || '{}');
    } catch {
      /* not JSON: judged by the exit code below */
    }
    if (res.code !== 0 || report.valid === false) {
      const diagnostics = (report.diagnostics ?? []).filter((d) => d.severity === 'error').map((d) => `${d.summary}${d.detail ? `: ${d.detail}` : ''}`);
      throw new TofuError(`tofu validate failed: ${diagnostics[0] ?? res.stderr.trim().slice(0, 300)}`.slice(0, 1500), diagnostics, res.kind);
    }
  }

  /**
   * The saved plan of this deployment, when it still matches the configuration about to be
   * applied; null when there is none (a resource created by this deployment is not planned ahead).
   */
  private async takeSavedPlan(stack: TofuStack, dir: string): Promise<string | null> {
    const { id, strict } = stack.savedPlan!;
    const hash = await readFile(join(dir, planHashFile(id)), 'utf8').catch(() => null);
    if (hash === null) return null;
    if (hash === configHash(stack.config)) return planFile(id);
    await this.dropSavedPlan(stack, dir);
    if (strict) {
      throw new TofuError('The configuration changed after the plan was approved (for example a dependency was replaced), so it was not applied. Deploy again to plan and approve the current changes.', [], 'failed');
    }
    stack.onLog?.({ level: 'warn', message: 'The configuration changed since the plan; planning and applying again.' });
    return null;
  }

  /** A saved plan holds attribute values (possibly sensitive): used once, then deleted. */
  private async dropSavedPlan(stack: TofuStack, dir: string): Promise<void> {
    const { id } = stack.savedPlan!;
    await rm(join(dir, planFile(id)), { force: true });
    await rm(join(dir, planHashFile(id)), { force: true });
  }

  private outputs(raw: TofuExecResult | undefined): Record<string, unknown> {
    if (raw?.code !== 0) throw new TofuError(`tofu output failed: ${raw?.stderr.trim().slice(0, 300) ?? ''}`, [], raw?.kind ?? 'failed');
    const parsed = JSON.parse(raw.stdout || '{}') as Record<string, { value: unknown; sensitive?: boolean }>;
    // Sensitive outputs are dropped: the control plane stores references, never secret values.
    return Object.fromEntries(Object.entries(parsed).filter(([, o]) => !o.sensitive).map(([k, o]) => [k, o.value]));
  }

  /**
   * One working directory per state and purpose: deployments (plan with -out, apply, destroy)
   * share `main`; speculative previews and drift scans get their own, so they never run `init` in
   * a directory an apply is using.
   */
  private dirFor(stack: TofuStack, purpose: 'main' | 'preview' | 'drift'): string {
    const id = createHash('sha256').update(stack.stateKey).digest('hex').slice(0, 24);
    return join(this.opts.workRoot, purpose === 'main' ? id : `${id}-${purpose}`);
  }

  private async prepare(stack: TofuStack, purpose: 'main' | 'preview' | 'drift'): Promise<string> {
    const dir = this.dirFor(stack, purpose);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'main.tf.json'), JSON.stringify(stack.config, null, 2));
    return dir;
  }

  /** JSON lines of a command's output; logs its diagnostics and throws when it failed. */
  private parse(stack: TofuStack, dir: string, args: string[], result: TofuExecResult, json: boolean): JsonLine[] {
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
      // A stale lock is released by hand (docs: self-hosting/opentofu): say where to run it.
      const where = /state lock/i.test(`${message} ${result.stderr}`) ? ` (work directory ${basename(dir)})` : '';
      throw new TofuError(`tofu ${args[0]} failed: ${message}`.slice(0, 1400) + where, diagnostics, result.kind);
    }
    return lines;
  }
}
