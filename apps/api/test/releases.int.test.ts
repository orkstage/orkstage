// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { demo, member, startApi, tenant, unique, type Api, type Caller } from './harness.js';

let api: Api;
let ctx: Awaited<ReturnType<typeof demo>>;
let admin: Caller;

beforeAll(async () => {
  api = await startApi();
  ctx = await demo(api.prisma);
  admin = await api.as(ctx.admin);
});

afterAll(async () => {
  await api?.close();
});

const TRIGGERS = `  triggers:
    - name: restart-api
      resource: api
      action: service.restart
    - name: scale-api
      resource: api
      action: service.scale
      params: { replicas: 2 }
    - name: canary-api
      resource: api
      action: release.canary
      params: { trafficPercent: 20 }
      overridable: [trafficPercent, bakeMinutes]
    - name: rollback-api
      resource: api
      action: release.rollback
`;

/** The starter template under a new name with release triggers, published. */
async function releaseTemplate(): Promise<string> {
  const starter = await api.prisma.templateVersion.findUniqueOrThrow({ where: { id: ctx.starterVersionId } });
  const name = `it-rel-${unique()}`;
  const source = `${starter.source.replace(/^ {2}name: starter-standard$/m, `  name: ${name}`).trimEnd()}\n${TRIGGERS}`;
  const created = await admin.post('/templates', { source });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const versionId = created.body.versions[0].id as string;
  const published = await admin.post(`/templates/${created.body.id}/versions/${versionId}/publish`);
  expect(published.status, JSON.stringify(published.body)).toBe(200);
  return versionId;
}

/** An instance as the worker would leave it: READY, with its API service deployed on the simulator. */
async function runningInstance(tenantId: string, templateVersionId: string, environment: 'production' | 'staging') {
  const slug = `rel-${unique()}`;
  const created = await admin.post('/instances', { tenantId, name: `Release ${slug}`, slug, environment, templateVersionId });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = created.body.id as string;
  const target = await api.prisma.cloudTarget.findFirstOrThrow({ where: { provider: 'mock' } });
  await api.prisma.instanceResource.create({
    data: {
      tenantId,
      instanceId: id,
      resourceId: 'api',
      type: 'compute.container-service',
      slot: 'primary',
      provider: 'mock',
      simulatedProvider: 'aws',
      targetId: target.id,
      region: target.defaultRegion,
      capability: 'ecs-fargate',
      capabilityName: 'Simulated ECS Fargate',
      name: `ork-${slug}-api`,
      status: 'ACTIVE',
    },
  });
  await api.prisma.instance.update({ where: { id }, data: { status: 'READY' } });
  return id;
}

describe('trigger runs on production wait for approval (ADR 0009)', () => {
  it('queues safe actions, parks disruptive ones until an admin approves or cancels them', async () => {
    const t = await tenant(admin, 'rel');
    const instanceId = await runningInstance(t.id, await releaseTemplate(), 'production');
    const dev = await api.as((await member(api.prisma, t.id, 'CustomerDeveloper')).email);
    const owner = await api.as((await member(api.prisma, t.id, 'CustomerOwner')).email);

    const restart = await dev.post(`/instances/${instanceId}/triggers/restart-api/runs`, {});
    expect(restart.status, JSON.stringify(restart.body)).toBe(202);
    expect(restart.body.status).toBe('QUEUED');

    const scale = await owner.post(`/instances/${instanceId}/triggers/scale-api/runs`, {});
    expect(scale.status, JSON.stringify(scale.body)).toBe(202);
    expect(scale.body).toMatchObject({ status: 'AWAITING_APPROVAL', approvedAt: null });

    expect((await dev.post(`/instances/${instanceId}/trigger-runs/${scale.body.id}/approve`)).status).toBe(403);
    const approved = await owner.post(`/instances/${instanceId}/trigger-runs/${scale.body.id}/approve`);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.status).toBe('QUEUED');
    expect(approved.body.approvedAt).not.toBeNull();
    expect((await owner.post(`/instances/${instanceId}/trigger-runs/${scale.body.id}/approve`)).body.error.code).toBe('NOT_AWAITING_APPROVAL');

    const again = await owner.post(`/instances/${instanceId}/triggers/scale-api/runs`, {});
    const cancelled = await owner.post(`/instances/${instanceId}/trigger-runs/${again.body.id}/cancel`);
    expect(cancelled.body).toMatchObject({ status: 'CANCELLED' });
  });
});

describe('releases and rollbacks (ADR 0009)', () => {
  it('starts a canary release as a deployment from a trigger and from the deploy call', async () => {
    const t = await tenant(admin, 'rel');
    const instanceId = await runningInstance(t.id, await releaseTemplate(), 'staging');

    const run = await admin.post(`/instances/${instanceId}/triggers/canary-api/runs`, {});
    expect(run.status, JSON.stringify(run.body)).toBe(202);
    expect(run.body).toMatchObject({ status: 'SUCCEEDED', url: `/deployments/${run.body.reference}` });
    const deployment = await admin.get(`/deployments/${run.body.reference}`);
    expect(deployment.body.release).toEqual({ strategy: 'canary', trafficPercent: 20, bakeMinutes: 15, autoRollback: true });

    // The instance is busy with that deployment now: triggers wait until it runs again.
    const busy = await admin.post(`/instances/${instanceId}/triggers/canary-api/runs`, {});
    expect(busy.body.error.code).toBe('INSTANCE_NOT_RUNNING');

    await api.prisma.instance.update({ where: { id: instanceId }, data: { status: 'READY' } });
    const params = await admin.post(`/instances/${instanceId}/triggers/canary-api/runs`, { params: { trafficPercent: 80 } });
    expect(params.body.error).toMatchObject({ code: 'INVALID_TRIGGER_PARAMS', message: 'trafficPercent must be a whole number from 1 to 50.' });
  });

  it('rolls back to the last verified deployment; admins only', async () => {
    const t = await tenant(admin, 'rel');
    const slug = `rb-${unique()}`;
    const created = await admin.post('/instances', { tenantId: t.id, name: 'Rollback', slug, environment: 'staging', templateVersionId: ctx.starterVersionId });
    const instanceId = created.body.id as string;

    // Two applies as the worker leaves them: the first verified, the second not (yet).
    const first = await admin.post(`/instances/${instanceId}/deploy`, { release: { bakeMinutes: 10 } });
    expect(first.status, JSON.stringify(first.body)).toBe(202);
    expect(first.body.release).toMatchObject({ strategy: 'rolling', bakeMinutes: 10 });
    await api.prisma.deployment.update({ where: { id: first.body.id }, data: { status: 'SUCCEEDED', finishedAt: new Date(), verifiedAt: new Date() } });
    await api.prisma.instance.update({ where: { id: instanceId }, data: { status: 'READY' } });
    const second = await admin.post(`/instances/${instanceId}/deploy`, {});
    await api.prisma.deployment.update({ where: { id: second.body.id }, data: { status: 'SUCCEEDED', finishedAt: new Date() } });
    await api.prisma.instance.update({ where: { id: instanceId }, data: { status: 'READY' } });

    const dev = await api.as((await member(api.prisma, t.id, 'CustomerDeveloper')).email);
    expect((await dev.post(`/instances/${instanceId}/rollback`, {})).body.error.code).toBe('ACTION_ROLE_REQUIRED');

    const rollback = await admin.post(`/instances/${instanceId}/rollback`, {});
    expect(rollback.status, JSON.stringify(rollback.body)).toBe(202);
    expect(rollback.body).toMatchObject({ kind: 'APPLY', status: 'QUEUED', rollbackToId: first.body.id });
    const row = await api.prisma.deployment.findUniqueOrThrow({ where: { id: rollback.body.id } });
    expect(row.templateVersionId).toBe(ctx.starterVersionId);
    expect((await api.prisma.instance.findUniqueOrThrow({ where: { id: instanceId } })).status).toBe('VALIDATING');

    // Another instance's deployment is not a target.
    await api.prisma.instance.update({ where: { id: instanceId }, data: { status: 'READY' } });
    const foreign = await admin.post(`/instances/${instanceId}/rollback`, { deploymentId: '00000000-0000-7000-8000-000000000000' });
    expect(foreign.body.error.code).toBe('NO_ROLLBACK_TARGET');
  });
});
