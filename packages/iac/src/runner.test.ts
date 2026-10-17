// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { driftChanges, TofuRunner, type TofuExec, type TofuExecResult, type TofuStack } from './runner.js';

const drift = (address: string, before: Record<string, unknown>, after: Record<string, unknown>, actions = ['update']) => ({
  address,
  change: { actions, before, after },
});

describe('driftChanges', () => {
  it('names the attributes changed outside OpenTofu, never their values', () => {
    const changes = driftChanges({
      resource_drift: [drift('aws_sqs_queue.this', { visibility_timeout_seconds: 30, tags: null }, { visibility_timeout_seconds: 300, tags: {} })],
    });
    expect(changes).toEqual([{ address: 'aws_sqs_queue.this', action: 'update', attributes: ['visibility_timeout_seconds'] }]);
    expect(JSON.stringify(changes)).not.toContain('300');
  });

  it('ignores representation-only differences: empty values and set order', () => {
    const changes = driftChanges({
      resource_drift: [
        drift('aws_ecr_repository.this', { tags: null, user_group_ids: null }, { tags: {}, user_group_ids: [] }),
        drift('aws_db_subnet_group.this', { subnet_ids: ['subnet-b', 'subnet-a'] }, { subnet_ids: ['subnet-a', 'subnet-b'] }),
        drift('aws_db_instance.this', { enabled_cloudwatch_logs_exports: [], domain_dns_ips: null }, { enabled_cloudwatch_logs_exports: null, domain_dns_ips: [] }),
      ],
    });
    expect(changes).toEqual([]);
  });

  it('reports deletions even without attribute values', () => {
    expect(driftChanges({ resource_drift: [drift('aws_ecs_service.this[0]', { name: 'api' }, {}, ['delete'])] })).toEqual([
      { address: 'aws_ecs_service.this[0]', action: 'delete', attributes: ['name'] },
    ]);
  });

  it('keeps real changes inside nested blocks', () => {
    const changes = driftChanges({
      resource_drift: [drift('aws_security_group.lb', { ingress: [{ from_port: 443, cidr_blocks: ['0.0.0.0/0'] }] }, { ingress: [{ from_port: 443, cidr_blocks: ['10.0.0.0/8'] }] })],
    });
    expect(changes).toEqual([{ address: 'aws_security_group.lb', action: 'update', attributes: ['ingress'] }]);
  });
});

describe('TofuRunner plan fidelity (open item 5)', () => {
  const summary = JSON.stringify({ type: 'change_summary', changes: { add: 1, change: 0, remove: 0 } });

  function harness(overrides: Partial<Record<string, TofuExecResult>> = {}) {
    const calls: { dir: string; args: string[] }[] = [];
    const exec: TofuExec = async (_stack, dir, args) => {
      calls.push({ dir, args });
      const ok = (stdout = '') => ({ code: 0, stdout, stderr: '', kind: 'failed' as const });
      const key = args[0] === 'apply' && args.some((a) => a.endsWith('.tfplan')) ? 'applySaved' : args[0]!;
      if (overrides[key]) return overrides[key]!;
      if (key === 'validate') return ok('{"valid":true,"diagnostics":[]}');
      if (key === 'output' || key === 'show') return ok('{}');
      return ok(summary);
    };
    const workRoot = mkdtempSync(join(tmpdir(), 'tofu-test-'));
    const runner = new TofuRunner({ image: 'tofu', workRoot, pluginCacheVolume: 'p', exec });
    const logs: string[] = [];
    const stack = (config: Record<string, unknown>, savedPlan?: TofuStack['savedPlan']): TofuStack => ({
      stateKey: 'target/us-east-1/orkstage/web.tfstate',
      config,
      env: {},
      savedPlan,
      onLog: (l) => logs.push(`${l.level}: ${l.message}`),
    });
    const commands = () => calls.map((c) => c.args.join(' '));
    return { calls, commands, runner, stack, logs };
  }

  it('validates, saves the deployment plan, and applies exactly that file', async () => {
    const h = harness();
    await h.runner.plan(h.stack({ a: 1 }, { id: 'd1', strict: true }));
    await h.runner.apply(h.stack({ a: 1 }, { id: 'd1', strict: true }));
    expect(h.commands()).toEqual([
      'init -input=false -no-color',
      'validate -json -no-color',
      'plan -input=false -json -out=deploy-d1.tfplan',
      'init -input=false -no-color',
      'validate -json -no-color',
      'apply -input=false -json deploy-d1.tfplan',
      'output -json',
    ]);
    expect(new Set(h.calls.map((c) => c.dir)).size).toBe(1);
    expect(existsSync(join(h.calls[0]!.dir, 'deploy-d1.sha256'))).toBe(false);
  });

  it('refuses, in production, to apply a plan made for another configuration', async () => {
    const h = harness();
    await h.runner.plan(h.stack({ a: 1 }, { id: 'd2', strict: true }));
    await expect(h.runner.apply(h.stack({ a: 2 }, { id: 'd2', strict: true }))).rejects.toThrow(/configuration changed after the plan was approved/);
    expect(h.commands().filter((c) => c.startsWith('apply'))).toEqual([]);
  });

  it('plans again outside production when the configuration changed, and says so', async () => {
    const h = harness();
    await h.runner.plan(h.stack({ a: 1 }, { id: 'd3', strict: false }));
    await h.runner.apply(h.stack({ a: 2 }, { id: 'd3', strict: false }));
    expect(h.commands()).toContain('apply -auto-approve -input=false -json');
    expect(h.logs.join('\n')).toMatch(/configuration changed since the plan/);
  });

  it('fails a stale saved plan in production, and falls back elsewhere', async () => {
    const stale = { code: 1, stdout: JSON.stringify({ type: 'diagnostic', diagnostic: { severity: 'error', summary: 'Saved plan is stale' } }), stderr: '', kind: 'failed' as const };
    const strict = harness({ applySaved: stale });
    await strict.runner.plan(strict.stack({ a: 1 }, { id: 'd4', strict: true }));
    await expect(strict.runner.apply(strict.stack({ a: 1 }, { id: 'd4', strict: true }))).rejects.toThrow(/infrastructure changed after the plan was approved/);

    const relaxed = harness({ applySaved: stale });
    await relaxed.runner.plan(relaxed.stack({ a: 1 }, { id: 'd5', strict: false }));
    await relaxed.runner.apply(relaxed.stack({ a: 1 }, { id: 'd5', strict: false }));
    expect(relaxed.commands()).toContain('apply -auto-approve -input=false -json');
  });

  it('runs previews and drift scans in their own directories, without locks or saved plans', async () => {
    const h = harness();
    await h.runner.plan(h.stack({ a: 1 }));
    await h.runner.drift(h.stack({ a: 1 }));
    await h.runner.apply(h.stack({ a: 1 }));
    const dirs = h.calls.map((c) => c.dir);
    expect(dirs[0]).toMatch(/-preview$/);
    expect(dirs.find((d) => d.endsWith('-drift'))).toBeDefined();
    expect(dirs.at(-1)).not.toMatch(/-(preview|drift)$/);
    expect(h.commands()).toContain('plan -input=false -json -lock=false');
  });

  it('names the work directory when a state lock is in the way', async () => {
    const locked = { code: 1, stdout: JSON.stringify({ type: 'diagnostic', diagnostic: { severity: 'error', summary: 'Error acquiring the state lock' } }), stderr: '', kind: 'failed' as const };
    const h = harness({ apply: locked });
    await expect(h.runner.apply(h.stack({ a: 1 }))).rejects.toThrow(/state lock \(work directory [0-9a-f]{24}\)/);
  });

  it('stops at validate when the configuration is invalid', async () => {
    const h = harness({ validate: { code: 1, stdout: JSON.stringify({ valid: false, diagnostics: [{ severity: 'error', summary: 'Unsupported argument' }] }), stderr: '', kind: 'failed' } });
    await expect(h.runner.apply(h.stack({ a: 1 }))).rejects.toThrow(/tofu validate failed: Unsupported argument/);
    expect(h.commands().some((c) => c.startsWith('apply'))).toBe(false);
  });
});
