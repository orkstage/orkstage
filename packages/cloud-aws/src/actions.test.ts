// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { rebootDatabase, restartService, scaleService, snapshotDatabase } from './actions.js';

/** A fake SDK client that records the commands it receives. */
function recorder(reply: unknown = {}) {
  const sent: { name: string; input: Record<string, unknown> }[] = [];
  return {
    sent,
    client: { send: (async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      sent.push({ name: cmd.constructor.name, input: cmd.input });
      return reply;
    }) as never },
  };
}

describe('AWS actions (ADR 0009)', () => {
  it('restarts an ECS service with a forced deployment', async () => {
    const r = recorder({ service: { deployments: [{ id: 'ecs-svc/1', status: 'PRIMARY' }] } });
    const result = await restartService(r.client, 'ork-acme-prod', 'ork-acme-prod-api');
    expect(r.sent).toEqual([{ name: 'UpdateServiceCommand', input: { cluster: 'ork-acme-prod', service: 'ork-acme-prod-api', forceNewDeployment: true } }]);
    expect(result).toMatchObject({ reference: 'ecs-svc/1', status: 'started' });
  });

  it('scales an ECS service, refusing anything but a whole number', async () => {
    const r = recorder();
    await scaleService(r.client, 'c', 's', 3);
    expect(r.sent[0]).toEqual({ name: 'UpdateServiceCommand', input: { cluster: 'c', service: 's', desiredCount: 3 } });
    await expect(scaleService(r.client, 'c', 's', 1.5)).rejects.toThrow(/whole number/);
  });

  it('reboots an RDS instance and takes a tagged manual snapshot', async () => {
    const r = recorder();
    await rebootDatabase(r.client, 'ork-acme-prod-db');
    const snap = await snapshotDatabase(r.client, 'ork-acme-prod-db', undefined, new Date('2026-10-23T18:05:00Z'));
    expect(r.sent[0]).toEqual({ name: 'RebootDBInstanceCommand', input: { DBInstanceIdentifier: 'ork-acme-prod-db' } });
    expect(r.sent[1]).toEqual({
      name: 'CreateDBSnapshotCommand',
      input: { DBInstanceIdentifier: 'ork-acme-prod-db', DBSnapshotIdentifier: 'ork-acme-prod-db-ork-202610231805', Tags: [{ Key: 'platform:snapshot-of', Value: 'ork-acme-prod-db' }] },
    });
    expect(snap.reference).toBe('ork-acme-prod-db-ork-202610231805');
  });
});
