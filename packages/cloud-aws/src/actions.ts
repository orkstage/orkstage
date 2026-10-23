// SPDX-License-Identifier: AGPL-3.0-only
import { type ECSClient, UpdateServiceCommand } from '@aws-sdk/client-ecs';
import { CreateDBSnapshotCommand, type RDSClient, RebootDBInstanceCommand } from '@aws-sdk/client-rds';
import type { ResourceActionDescriptor, ResourceActionResult } from '@orkstage/cloud-core';

/** Catalog actions (ADR 0009) on ECS services, under their catalog names. */
export const ECS_ACTIONS: ResourceActionDescriptor[] = [
  {
    name: 'service.restart',
    description: 'Start fresh tasks of the running task definition (ECS force new deployment); old tasks drain as the new ones turn healthy.',
    params: [],
  },
  {
    name: 'service.scale',
    description: 'Set the desired number of tasks. When the template turns autoscaling on, ECS keeps the count within its bounds.',
    params: [{ name: 'replicas', type: 'number', required: true, description: 'Tasks to run.' }],
  },
];

/** Catalog actions on RDS databases besides the point in time restore (backups.ts). */
export const RDS_OPERATIONS: ResourceActionDescriptor[] = [
  { name: 'database.reboot', description: 'Reboot the RDS instance: connections drop for a short while; a Multi-AZ instance fails over.', params: [] },
  { name: 'database.snapshot', description: 'Take a manual RDS snapshot. It is kept until someone deletes it.', params: [] },
];

export async function restartService(client: Pick<ECSClient, 'send'>, cluster: string, service: string, signal?: AbortSignal): Promise<ResourceActionResult> {
  const out = await client.send(new UpdateServiceCommand({ cluster, service, forceNewDeployment: true }), { abortSignal: signal });
  return {
    reference: out.service?.deployments?.find((d) => d.status === 'PRIMARY')?.id,
    status: 'started',
    message: `New tasks are starting for ${service}; the old ones drain as the new ones turn healthy.`,
  };
}

export async function scaleService(client: Pick<ECSClient, 'send'>, cluster: string, service: string, replicas: number, signal?: AbortSignal): Promise<ResourceActionResult> {
  if (!Number.isInteger(replicas) || replicas < 0) throw new Error('replicas must be a whole number of tasks.');
  await client.send(new UpdateServiceCommand({ cluster, service, desiredCount: replicas }), { abortSignal: signal });
  return { status: 'started', message: `${service} is moving to ${replicas} task${replicas === 1 ? '' : 's'}.` };
}

export async function rebootDatabase(client: Pick<RDSClient, 'send'>, identifier: string, signal?: AbortSignal): Promise<ResourceActionResult> {
  await client.send(new RebootDBInstanceCommand({ DBInstanceIdentifier: identifier }), { abortSignal: signal });
  return { reference: identifier, status: 'started', message: `${identifier} is rebooting; connections drop for a short while.` };
}

export async function snapshotDatabase(client: Pick<RDSClient, 'send'>, identifier: string, signal?: AbortSignal, now = new Date()): Promise<ResourceActionResult> {
  const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 12);
  const snapshot = `${identifier.slice(0, 200)}-ork-${stamp}`;
  await client.send(
    new CreateDBSnapshotCommand({ DBInstanceIdentifier: identifier, DBSnapshotIdentifier: snapshot, Tags: [{ Key: 'platform:snapshot-of', Value: identifier }] }),
    { abortSignal: signal },
  );
  return { reference: snapshot, status: 'started', message: `Snapshot ${snapshot} of ${identifier} started; it is kept until deleted.` };
}
