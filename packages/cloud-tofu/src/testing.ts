// SPDX-License-Identifier: AGPL-3.0-only
import type { ApplyResult, DriftChange, PlanResult, TofuRunner, TofuStack } from '@orkstage/iac';
import type { StateStore } from './state.js';

/**
 * Test doubles for adapters built on `OpenTofuAdapter`, shared by their contract tests
 * (`@orkstage/cloud-tofu/testing`). Nothing here talks to a cloud or starts a container.
 */

/** State kept in memory, for adapters whose real store is not reachable through `fetch` (the S3 SDK). */
export class MemoryStateStore implements StateStore {
  readonly location = 'memory://state';
  readonly objects = new Map<string, string>();
  async check(): Promise<void> {}
  async get(key: string): Promise<string | null> {
    return this.objects.get(key) ?? null;
  }
  async put(key: string, body: string): Promise<void> {
    this.objects.set(key, body);
  }
  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

export interface FakeTofuOptions {
  /**
   * Where the backend writes state: the same storage the adapter's state store reads (a
   * `MemoryStateStore`, or the provider's real store class on top of a fake `fetch`).
   */
  state: Pick<StateStore, 'get' | 'put'>;
  /** Module outputs for the given module inputs, as the real module would publish them. */
  outputs: (inputs: Record<string, unknown>, stack: TofuStack) => Record<string, unknown>;
  /** Module inputs the provider cannot change in place: a change to one of them plans a replacement. */
  replaceOn?: string[];
}

export type FakeTofuCommand = 'apply' | 'plan' | 'drift' | 'destroy';

interface FakeState {
  resources?: { mode: string; instances?: { attributes?: Record<string, unknown> }[] }[];
  outputs?: { all?: { value?: Record<string, unknown> } };
}

/** Address of the one resource the fake module manages. */
export const FAKE_RESOURCE_ADDRESS = 'module.resource.fake_resource.this';

/**
 * Stateful stand in for the OpenTofu runner. `apply` records the module inputs and outputs in the
 * state object the configuration's backend points at (`key`, or `prefix` for gcs), so a repeated
 * apply of the same configuration changes nothing and the adapter reads existence and outputs
 * from state as it does in production. `destroy` leaves an empty state behind, like OpenTofu.
 */
export class FakeTofu {
  readonly runner: TofuRunner;
  /** Every command run, in order, with the environment it got (assert credentials stay there). */
  readonly commands: { command: FakeTofuCommand; stateKey: string; env: Record<string, string> }[] = [];
  private readonly live = new Map<string, Record<string, unknown>>();

  constructor(private readonly opts: FakeTofuOptions) {
    this.runner = {
      apply: (stack: TofuStack) => this.apply(stack),
      plan: (stack: TofuStack) => this.plan(stack),
      drift: (stack: TofuStack) => this.drift(stack),
      destroy: (stack: TofuStack) => this.destroy(stack),
    } as unknown as TofuRunner;
  }

  /** Outputs of every stack that currently has a resource: what a fake provider API should report as present. */
  liveOutputs(): Record<string, unknown>[] {
    return [...this.live.values()];
  }

  /** True when some live stack published `value` under `key` (handy for existence probes). */
  isLive(key: string, value: unknown): boolean {
    return this.liveOutputs().some((o) => o[key] === value);
  }

  async apply(stack: TofuStack): Promise<ApplyResult> {
    const key = this.record('apply', stack);
    const inputs = moduleInputs(stack);
    const previous = await this.read(key);
    const action = this.actionFor(previous, inputs);
    const outputs = action === 'noop' && previous?.outputs ? previous.outputs : this.opts.outputs(inputs, stack);
    await this.opts.state.put(
      key,
      JSON.stringify({
        version: 4,
        resources: [{ mode: 'managed', type: 'fake_resource', name: 'this', module: 'module.resource', instances: [{ attributes: inputs }] }],
        outputs: { all: { value: outputs, type: 'dynamic' } },
      }),
    );
    this.live.set(key, outputs);
    return { outputs: { all: outputs }, changes: changesFor(action) };
  }

  async plan(stack: TofuStack): Promise<PlanResult> {
    const key = this.record('plan', stack);
    const action = this.actionFor(await this.read(key), moduleInputs(stack));
    return { changes: changesFor(action), actions: action === 'noop' ? [] : [{ address: FAKE_RESOURCE_ADDRESS, action }] };
  }

  async drift(stack: TofuStack): Promise<DriftChange[]> {
    this.record('drift', stack);
    return [];
  }

  async destroy(stack: TofuStack): Promise<void> {
    const key = this.record('destroy', stack);
    await this.opts.state.put(key, JSON.stringify({ version: 4, resources: [], outputs: {} }));
    this.live.delete(key);
  }

  private record(command: FakeTofuCommand, stack: TofuStack): string {
    this.commands.push({ command, stateKey: stack.stateKey, env: stack.env });
    return backendKey(stack);
  }

  private async read(key: string): Promise<{ inputs: Record<string, unknown>; outputs?: Record<string, unknown> } | null> {
    const raw = await this.opts.state.get(key);
    if (!raw) return null;
    const state = JSON.parse(raw) as FakeState;
    const managed = (state.resources ?? []).find((r) => r.mode === 'managed');
    if (!managed) return null;
    return { inputs: managed.instances?.[0]?.attributes ?? {}, outputs: state.outputs?.all?.value };
  }

  private actionFor(previous: { inputs: Record<string, unknown> } | null, inputs: Record<string, unknown>): 'create' | 'update' | 'replace' | 'noop' {
    if (!previous) return 'create';
    const changed = Object.keys({ ...previous.inputs, ...inputs }).filter((k) => JSON.stringify(previous.inputs[k]) !== JSON.stringify(inputs[k]));
    if (changed.length === 0) return 'noop';
    return changed.some((k) => this.opts.replaceOn?.includes(k)) ? 'replace' : 'update';
  }
}

function changesFor(action: 'create' | 'update' | 'replace' | 'noop'): ApplyResult['changes'] {
  return {
    add: action === 'create' || action === 'replace' ? 1 : 0,
    change: action === 'update' ? 1 : 0,
    remove: action === 'replace' ? 1 : 0,
  };
}

/** The inputs the root configuration passes to its module, without the module source. */
function moduleInputs(stack: TofuStack): Record<string, unknown> {
  const { source: _source, ...inputs } = (stack.config.module as { resource?: Record<string, unknown> } | undefined)?.resource ?? {};
  return inputs;
}

/** The state key the backend block writes to: `key` for s3 and azurerm, `prefix` for gcs. */
function backendKey(stack: TofuStack): string {
  const backend = (stack.config.terraform as { backend?: Record<string, { key?: string; prefix?: string }> } | undefined)?.backend ?? {};
  const block = Object.values(backend)[0];
  const key = block?.key ?? block?.prefix;
  if (!key) throw new Error(`Fake OpenTofu: the configuration for ${stack.stateKey} has no backend key.`);
  return key;
}
