// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { demo, startApi, unique, type Api, type Caller } from './harness.js';

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

const source = (name: string, opts: { version?: string; description?: string; providers?: string } = {}) => `apiVersion: platform/v1
kind: EnvironmentTemplate
metadata:
  name: ${name}
  version: ${opts.version ?? '1.0.0'}
  displayName: Lifecycle ${name}
  description: ${opts.description ?? 'Created by the integration suite.'}
  nonProduction: true
spec:
  placements:
    - name: primary${opts.providers ? `\n      providers: [${opts.providers}]` : ''}
  resources:
    - id: network
      type: network
      availabilityZones: 1
`;

async function draft(opts: { providers?: string } = {}) {
  const name = `it-${unique()}`;
  const created = await admin.post('/templates', { source: source(name, opts) });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return { name, id: created.body.id as string, versionId: created.body.versions[0].id as string };
}

describe('template lifecycle (open item 13)', () => {
  it('a draft can change; once published it is frozen, also in the database', async () => {
    const t = await draft();
    const edited = await admin.request('PUT', `/templates/${t.id}/versions/${t.versionId}`, { source: source(t.name, { description: 'Edited draft.' }) });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body.document.metadata.description).toBe('Edited draft.');
    expect((await admin.request('PUT', `/templates/${t.id}/versions/${t.versionId}`, { source: source(t.name, { version: '2.0.0' }) })).body.error.code).toBe('VERSION_MISMATCH');

    const published = await admin.post(`/templates/${t.id}/versions/${t.versionId}/publish`);
    expect(published.status, JSON.stringify(published.body)).toBe(200);
    const late = await admin.request('PUT', `/templates/${t.id}/versions/${t.versionId}`, { source: source(t.name, { description: 'Too late.' }) });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('VERSION_NOT_DRAFT');

    await expect(api.prisma.templateVersion.update({ where: { id: t.versionId }, data: { source: 'changed' } })).rejects.toThrow();
    await expect(api.prisma.templateVersion.update({ where: { id: t.versionId }, data: { status: 'DRAFT' } })).rejects.toThrow();
  });

  it('a deprecated version keeps its instances but takes no new ones, until it is restored', async () => {
    const t = await draft();
    expect((await admin.post(`/templates/${t.id}/versions/${t.versionId}/publish`)).status).toBe(200);
    const instance = { tenantId: ctx.acme.id, name: 'Lifecycle', environment: 'development', templateVersionId: t.versionId };
    const running = await admin.post('/instances', { ...instance, slug: `lc-${unique()}` });
    expect(running.status, JSON.stringify(running.body)).toBe(201);

    const deprecated = await admin.post(`/templates/${t.id}/versions/${t.versionId}/deprecate`, { note: 'Use 2.0.0.' });
    expect(deprecated.status, JSON.stringify(deprecated.body)).toBe(200);
    expect(deprecated.body).toMatchObject({ status: 'DEPRECATED', deprecationNote: 'Use 2.0.0.', instanceCount: 1 });
    const refused = await admin.post('/instances', { ...instance, slug: `lc-${unique()}` });
    expect(refused.status).toBe(422);
    expect(refused.body.error).toMatchObject({ code: 'TEMPLATE_DEPRECATED', message: 'Version 1.0.0 is deprecated. Use 2.0.0. Choose a newer version.' });
    expect((await admin.get(`/instances/${running.body.id}`)).status).toBe(200);

    expect((await admin.post(`/templates/${t.id}/versions/${t.versionId}/restore`)).body.status).toBe('PUBLISHED');
    expect((await admin.post('/instances', { ...instance, slug: `lc-${unique()}` })).status).toBe(201);
  });

  it('publishing is refused when no shared target could run the capability checks', async () => {
    const t = await draft({ providers: 'gcp' });
    const res = await admin.post(`/templates/${t.id}/versions/${t.versionId}/publish`);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CAPABILITY_UNCHECKED');
  });

  it('members cannot deprecate', async () => {
    const t = await draft();
    const owner = await api.as(ctx.acmeOwner);
    expect((await owner.post(`/templates/${t.id}/versions/${t.versionId}/deprecate`, {})).status).toBe(403);
  });
});
