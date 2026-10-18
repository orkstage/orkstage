// SPDX-License-Identifier: AGPL-3.0-only
import { runAdapterContract } from '@orkstage/cloud-core/testing';
import type { CloudTarget, ProviderContext, ResourceRequest } from '@orkstage/cloud-core';
import { describe, expect, it } from 'vitest';
import { checkParams, VercelAdapter } from './adapter.js';
import type { Deployment, DeploymentEvent, EnvVar, Project } from './api.js';
import { deploymentStatus } from './health.js';

const TOKEN = 'vercel-test-token-0123456789';
const DB_PASSWORD = 'pa55-W0rd-never-shown';

interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

/** In-memory Vercel REST API, enough to drive the adapter end to end. */
class FakeVercel {
  projects = new Map<string, Project>();
  envs = new Map<string, EnvVar[]>();
  domains = new Map<string, string[]>();
  deployments: (Deployment & { projectId: string })[] = [];
  events: DeploymentEvent[] = [];
  calls: Call[] = [];
  siteStatus = 200;
  /** Returns a canned failure for a matching `METHOD path` before the normal handler runs. */
  failures = new Map<string, { status: number; body: unknown }>();
  private seq = 0;

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    if (url.host !== 'api.vercel.com') return new Response('ok', { status: this.siteStatus });
    if (init?.headers && (init.headers as Record<string, string>).authorization !== `Bearer ${TOKEN}`) return json(401, { error: { code: 'forbidden', message: 'bad token' } });
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    this.calls.push({ method, path: url.pathname, query: url.searchParams, body });
    const fail = this.failures.get(`${method} ${url.pathname}`);
    if (fail) return json(fail.status, fail.body);
    return this.route(method, url, body);
  };

  private find(ref: string) {
    return this.projects.get(ref) ?? [...this.projects.values()].find((p) => p.name === ref);
  }

  private route(method: string, url: URL, body: any): Response {
    const p = url.pathname;
    let m: RegExpMatchArray | null;
    if (method === 'GET' && p === '/v2/user') return json(200, { user: { username: 'paulo' } });
    if (method === 'GET' && (m = p.match(/^\/v2\/teams\/([^/]+)$/))) return json(200, { id: m[1], slug: 'acme' });
    if (method === 'GET' && p === '/v10/projects') return json(200, { projects: [] });
    if (method === 'POST' && p === '/v11/projects') {
      const [org, repo] = String(body.gitRepository.repo).split('/');
      const project: Project = {
        id: `prj_${++this.seq}`,
        name: body.name,
        framework: body.framework,
        buildCommand: body.buildCommand,
        installCommand: body.installCommand,
        outputDirectory: body.outputDirectory,
        rootDirectory: body.rootDirectory,
        nodeVersion: '22.x',
        resourceConfig: body.resourceConfig,
        link: { type: 'github', org, repo, productionBranch: 'main' },
      };
      this.projects.set(project.id, project);
      return json(200, project);
    }
    if ((m = p.match(/^\/v9\/projects\/([^/]+)$/))) {
      const project = this.find(decodeURIComponent(m[1]!));
      if (!project) return json(404, { error: { code: 'not_found', message: 'Project not found' } });
      if (method === 'GET') return json(200, project);
      if (method === 'DELETE') {
        this.projects.delete(project.id);
        return new Response(null, { status: 204 });
      }
      if (method === 'PATCH') {
        const { serverlessFunctionRegion: _r, previewDeploymentsDisabled: _p, ...rest } = body;
        Object.assign(project, rest);
        return json(200, project);
      }
    }
    if ((m = p.match(/^\/v10\/projects\/([^/]+)\/env$/))) {
      const list = this.envs.get(m[1]!) ?? [];
      if (method === 'GET') return json(200, { envs: list.map(({ ...e }) => ({ ...e, value: e.type === 'sensitive' ? '' : 'enc' })) });
      for (const v of body as (EnvVar & { value: string })[]) {
        const i = list.findIndex((e) => e.key === v.key);
        const entry = { id: `env_${++this.seq}`, key: v.key, type: v.type, target: v.target, comment: v.comment, value: v.value };
        if (i >= 0) list[i] = entry;
        else list.push(entry);
      }
      this.envs.set(m[1]!, list);
      return json(201, { created: [], failed: [] });
    }
    if (method === 'DELETE' && (m = p.match(/^\/v9\/projects\/([^/]+)\/env\/([^/]+)$/))) {
      this.envs.set(m[1]!, (this.envs.get(m[1]!) ?? []).filter((e) => e.id !== m![2]));
      return json(200, {});
    }
    if (method === 'GET' && (m = p.match(/^\/v9\/projects\/([^/]+)\/domains$/))) return json(200, { domains: (this.domains.get(m[1]!) ?? []).map((name) => ({ name })) });
    if (method === 'POST' && (m = p.match(/^\/v10\/projects\/([^/]+)\/domains$/))) {
      this.domains.set(m[1]!, [...(this.domains.get(m[1]!) ?? []), body.name]);
      return json(200, { name: body.name, verified: false });
    }
    if (method === 'POST' && p === '/v13/deployments') {
      const project = this.find(body.project)!;
      const d = { uid: `dpl_${++this.seq}`, url: `${project.name}-${this.seq}.vercel.app`, readyState: 'READY' as const, target: body.target ?? null, createdAt: Date.now() + this.seq, projectId: project.id, meta: { githubCommitSha: 'a'.repeat(40) } };
      this.deployments.push(d);
      if (body.target === 'production') project.targets = { production: { id: d.uid, alias: [`${project.name}.vercel.app`] } };
      return json(200, { id: d.uid, url: d.url, readyState: 'QUEUED' });
    }
    if (method === 'GET' && p === '/v7/deployments') {
      let list = this.deployments.filter((d) => d.projectId === url.searchParams.get('projectId') || this.find(url.searchParams.get('projectId')!)?.id === d.projectId);
      if (url.searchParams.get('target')) list = list.filter((d) => d.target === url.searchParams.get('target'));
      if (url.searchParams.get('state')) list = list.filter((d) => d.readyState === url.searchParams.get('state'));
      list = [...list].sort((a, b) => b.createdAt - a.createdAt).slice(0, Number(url.searchParams.get('limit') ?? 20));
      return json(200, { deployments: list, pagination: {} });
    }
    if (method === 'GET' && p.match(/^\/v3\/deployments\/[^/]+\/events$/)) return json(200, this.events);
    if (method === 'POST' && (p.match(/^\/v10\/projects\/[^/]+\/promote\//) || p.match(/^\/v1\/projects\/[^/]+\/rollback\//))) return new Response(null, { status: 201 });
    if (method === 'POST' && p === '/v1/edge-cache/invalidate-by-tags') return json(200, {});
    return json(404, { error: { code: 'not_found', message: `no route ${method} ${p}` } });
  }

  writes() {
    return this.calls.filter((c) => c.method !== 'GET');
  }
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const target = (config: Record<string, unknown> = {}): CloudTarget => ({
  id: 't-vercel',
  provider: 'vercel',
  name: 'Acme web',
  config,
  credentialRef: 'env://VERCEL_TOKEN',
  allowedRegions: ['iad1', 'gru1', 'eu-west-1'],
  defaultRegion: 'iad1',
});

function setup(config: Record<string, unknown> = {}) {
  const api = new FakeVercel();
  const adapter = new VercelAdapter({ resolveSecret: async () => TOKEN, fetch: api.fetch });
  const ctx: ProviderContext = {
    target: target(config),
    region: 'iad1',
    correlationId: 'c1',
    dependencySecret: async (id): Promise<Record<string, string>> => (id === 'db' ? { username: 'app', password: DB_PASSWORD } : {}),
  };
  return { api, adapter, ctx };
}

const request = (over: Partial<ResourceRequest> = {}, spec: Record<string, unknown> = {}): ResourceRequest => ({
  resourceId: 'site',
  serviceKind: 'web.frontend',
  capability: 'vercel-project',
  name: 'ork-acme-prod-site',
  tags: { 'platform:environment': 'production' },
  spec: {
    source: { repository: 'acme/web', branch: 'main', gitProvider: 'github' },
    framework: 'nextjs',
    environment: { NEXT_PUBLIC_API: 'https://api.acme.dev' },
    domains: ['www.acme.dev'],
    previewDeployments: true,
    healthCheckPath: '/health',
    ...spec,
  },
  dependencyOutputs: {},
  idempotencyKey: 'k1',
  ...over,
});

describe('VercelAdapter.ensureResource', () => {
  it('creates the project, environment, domain and a production deployment', async () => {
    const { api, adapter, ctx } = setup();
    const result = await adapter.ensureResource(ctx, request());
    expect(result.unchanged).toBe(false);
    const create = api.calls.find((c) => c.path === '/v11/projects')!;
    expect(create.body).toMatchObject({
      name: 'ork-acme-prod-site',
      framework: 'nextjs',
      gitRepository: { type: 'github', repo: 'acme/web' },
      serverlessFunctionRegion: 'iad1',
      buildCommand: null,
      previewDeploymentsDisabled: false,
    });
    const deploy = api.calls.find((c) => c.path === '/v13/deployments')!;
    expect(deploy.body).toMatchObject({ target: 'production', gitSource: { type: 'github', org: 'acme', repo: 'web', ref: 'main' } });
    expect(api.domains.get(result.providerResourceId)).toEqual(['www.acme.dev']);
    expect(result.outputs).toMatchObject({
      kind: 'web.frontend',
      project_id: result.providerResourceId,
      url: 'https://www.acme.dev',
      dashboard_url: 'https://vercel.com/paulo/ork-acme-prod-site',
      framework: 'nextjs',
    });
  });

  it('is unchanged on repeat and writes nothing', async () => {
    const { api, adapter, ctx } = setup();
    const first = await adapter.ensureResource(ctx, request());
    api.calls = [];
    const second = await adapter.ensureResource(ctx, request());
    expect(second).toMatchObject({ providerResourceId: first.providerResourceId, unchanged: true });
    expect(api.writes()).toEqual([]);
  });

  it('patches only the differences and redeploys', async () => {
    const { api, adapter, ctx } = setup();
    await adapter.ensureResource(ctx, request());
    api.calls = [];
    const result = await adapter.ensureResource(ctx, request({}, { buildCommand: 'pnpm build', nodeVersion: '20' }));
    expect(result.unchanged).toBe(false);
    const patch = api.calls.find((c) => c.method === 'PATCH')!;
    expect(patch.body).toEqual({ buildCommand: 'pnpm build', nodeVersion: '20.x', previewDeploymentsDisabled: false });
    expect(api.calls.filter((c) => c.path === '/v13/deployments')).toHaveLength(1);
    expect(api.calls.some((c) => c.path.endsWith('/env') && c.method === 'POST')).toBe(false);
  });

  it('wires dependencies: settings as encrypted, credentials as sensitive, values never in outputs', async () => {
    const { api, adapter, ctx } = setup();
    const req = request({ dependencyOutputs: { db: { kind: 'database.postgresql', host: 'db.example.net', port: 5432, secret_ref: 'supabase://db' } } });
    const result = await adapter.ensureResource(ctx, req);
    const vars = api.calls.find((c) => c.path.endsWith('/env') && c.method === 'POST')!.body as { key: string; type: string; target: string[]; value: string }[];
    expect(vars.find((v) => v.key === 'DB_HOST')).toMatchObject({ type: 'encrypted', value: 'db.example.net' });
    expect(vars.find((v) => v.key === 'NEXT_PUBLIC_API')).toMatchObject({ type: 'encrypted' });
    expect(vars.find((v) => v.key === 'DB_PASSWORD')).toMatchObject({ type: 'sensitive', target: ['production', 'preview'], value: DB_PASSWORD });
    expect(JSON.stringify(result)).not.toContain(DB_PASSWORD);
    // Comments carry a keyed fingerprint, never the value.
    expect(JSON.stringify(api.envs.get(result.providerResourceId)!.map((e) => e.comment))).not.toContain(DB_PASSWORD);

    api.calls = [];
    expect((await adapter.ensureResource(ctx, req)).unchanged).toBe(true);

    ctx.dependencySecret = async () => ({ username: 'app', password: 'rotated-password-1' });
    api.calls = [];
    expect((await adapter.ensureResource(ctx, req)).unchanged).toBe(false);
    const rotated = api.calls.find((c) => c.path.endsWith('/env') && c.method === 'POST')!.body as { key: string }[];
    expect(rotated.map((v) => v.key)).toEqual(['DB_PASSWORD']);
  });

  it('keeps secret values out of thrown errors', async () => {
    const { api, adapter, ctx } = setup();
    await adapter.ensureResource(ctx, request());
    const id = [...api.projects.keys()][0]!;
    api.failures.set(`POST /v10/projects/${id}/env`, { status: 400, body: { error: { code: 'bad_request', message: `Value ${DB_PASSWORD} is invalid` } } });
    const req = request({ dependencyOutputs: { db: { kind: 'database.postgresql', secret_ref: 'x' } } });
    const err = (await adapter.ensureResource(ctx, req).catch((e) => e)) as Error;
    expect(err.message).toContain('HTTP 400');
    expect(err.message).not.toContain(DB_PASSWORD);
    expect(err.message).not.toContain(TOKEN);
  });

  it('fails clearly when a dependency publishes credentials but no reader is available', async () => {
    const { adapter, ctx } = setup();
    delete ctx.dependencySecret;
    await expect(adapter.ensureResource(ctx, request({ dependencyOutputs: { db: { kind: 'database.postgresql', secret_ref: 'x' } } }))).rejects.toMatchObject({
      code: 'VERCEL_DEPENDENCY_SECRET_UNAVAILABLE',
      failureClass: 'VALIDATION_ERROR',
    });
  });

  it('tells the user to install the Vercel GitHub app when the repository is not reachable', async () => {
    const { api, adapter, ctx } = setup();
    api.failures.set('POST /v11/projects', {
      status: 400,
      body: { error: { code: 'bad_request', message: 'To link a GitHub repository, you need to install the GitHub integration first.' } },
    });
    const err = await adapter.ensureResource(ctx, request()).catch((e) => e);
    expect(err).toMatchObject({ code: 'VERCEL_GIT_NOT_CONNECTED', failureClass: 'VALIDATION_ERROR' });
    expect(err.message).toContain('Vercel GitHub app');
    expect(err.message).toContain('acme/web');
  });

  it('adds teamId to every API call for team targets, and never for personal accounts', async () => {
    const team = setup({ teamId: 'team_abc123' });
    const res = await team.adapter.ensureResource(team.ctx, request());
    expect(team.api.calls.length).toBeGreaterThan(5);
    expect(team.api.calls.every((c) => c.query.get('teamId') === 'team_abc123')).toBe(true);
    expect(res.outputs.dashboard_url).toBe('https://vercel.com/acme/ork-acme-prod-site');

    const personal = setup();
    await personal.adapter.ensureResource(personal.ctx, request());
    expect(personal.api.calls.every((c) => !c.query.has('teamId'))).toBe(true);
  });
});

describe('VercelAdapter health, history and logs', () => {
  it('maps the latest production deployment and the HTTP check', async () => {
    const { api, adapter, ctx } = setup();
    const created = await adapter.ensureResource(ctx, request());
    const ident = { ...request(), providerResourceId: created.providerResourceId, outputs: created.outputs };
    expect((await adapter.checkHealth(ctx, ident)).state).toBe('HEALTHY');

    api.siteStatus = 503;
    expect((await adapter.checkHealth(ctx, ident)).state).toBe('UNHEALTHY');
    api.siteStatus = 200;

    const latest = api.deployments.at(-1)!;
    latest.readyState = 'BUILDING';
    expect(await adapter.checkHealth(ctx, ident)).toMatchObject({ state: 'DEGRADED' });
    latest.readyState = 'ERROR';
    latest.errorMessage = 'Command "pnpm build" exited with 1';
    expect(await adapter.checkHealth(ctx, ident)).toMatchObject({ state: 'UNHEALTHY' });
  });

  it('reports UNKNOWN before the first production deployment', async () => {
    const { adapter, ctx } = setup();
    expect((await adapter.checkHealth(ctx, request())).state).toBe('UNKNOWN');
  });

  it('lists deployments with live and superseded states and commit revisions', async () => {
    const { adapter, ctx } = setup();
    const created = await adapter.ensureResource(ctx, request());
    await adapter.runAction(ctx, { ...request(), providerResourceId: created.providerResourceId }, { action: 'redeploy', params: {} });
    const list = await adapter.listDeployments(ctx, { ...request(), providerResourceId: created.providerResourceId }, 10);
    expect(list.map((d) => d.status)).toEqual(['live', 'superseded']);
    expect(list[0]).toMatchObject({ revision: 'a'.repeat(40) });
    expect(list[0]!.url).toMatch(/^https:\/\//);
    expect(deploymentStatus('QUEUED', null, false)).toBe('queued');
    expect(deploymentStatus('CANCELED', 'production', false)).toBe('cancelled');
  });

  it('maps build events to log lines and redacts them', async () => {
    const { api, adapter, ctx } = setup();
    const created = await adapter.ensureResource(ctx, request());
    api.events = [
      { type: 'stdout', created: 2000, text: 'Build completed for user ops@acme.dev' },
      { type: 'stderr', created: 1000, text: 'warn: something' },
      { type: 'delimiter', created: 1500, text: '' },
      { type: 'stdout', created: 3000, payload: { text: 'Deployed', date: 3000 } },
    ];
    const lines = await adapter.getLogs(ctx, { ...request(), providerResourceId: created.providerResourceId }, 10);
    expect(lines.map((l) => l.level)).toEqual(['error', 'info', 'info']);
    expect(lines[1]!.message).toBe('Build completed for user <email>');
    expect(lines[2]!.message).toBe('Deployed');
  });

  it('deletes idempotently and probes existence', async () => {
    const { adapter, ctx } = setup();
    const created = await adapter.ensureResource(ctx, request());
    const ident = { ...request(), providerResourceId: created.providerResourceId };
    expect(await adapter.probeExists(ctx, ident)).toBe(true);
    await adapter.deleteResource(ctx, ident);
    await adapter.deleteResource(ctx, ident);
    expect(await adapter.probeExists(ctx, ident)).toBe(false);
    expect((await adapter.getResource(ctx, ident)).exists).toBe(false);
  });
});

describe('VercelAdapter actions', () => {
  it('describes its actions only for vercel-project', () => {
    const { adapter } = setup();
    expect(adapter.actions('vercel-project').map((a) => a.name)).toEqual(['redeploy', 'promote', 'rollback', 'purge-cache']);
    expect(adapter.actions('other')).toEqual([]);
  });

  it('validates parameters before calling the API', () => {
    expect(() => checkParams({ action: 'promote', params: {} })).toThrow(/needs deploymentId/);
    expect(() => checkParams({ action: 'promote', params: { deploymentId: 'nope' } })).toThrow(/dpl_/);
    expect(() => checkParams({ action: 'redeploy', params: { ref: 42 } })).toThrow(/must be a string/);
    expect(() => checkParams({ action: 'redeploy', params: { target: 'staging' } })).toThrow(/production or preview/);
    expect(() => checkParams({ action: 'redeploy', params: { force: true } })).toThrow(/does not accept/);
    expect(() => checkParams({ action: 'restart', params: {} })).toThrow(/Unknown action/);
    expect(checkParams({ action: 'rollback', params: {} })).toEqual({});
  });

  it('redeploys a commit, promotes, rolls back to the previous production build and purges the cache', async () => {
    const { api, adapter, ctx } = setup();
    const created = await adapter.ensureResource(ctx, request());
    const ident = { ...request(), providerResourceId: created.providerResourceId, outputs: created.outputs };
    const firstProd = api.deployments[0]!.uid;

    const sha = 'b'.repeat(40);
    const redeploy = await adapter.runAction(ctx, ident, { action: 'redeploy', params: { ref: sha } });
    expect(redeploy).toMatchObject({ status: 'started', reference: api.deployments[1]!.uid });
    expect(redeploy.url).toMatch(/^https:\/\/.+\.vercel\.app$/);
    expect(api.calls.at(-1)!.body).toMatchObject({ target: 'production', gitSource: { ref: 'main', sha } });

    const preview = await adapter.runAction(ctx, ident, { action: 'redeploy', params: { ref: 'feature/x', target: 'preview' } });
    expect((api.calls.at(-1)!.body as Record<string, unknown>).target).toBeUndefined();
    expect(preview.message).toContain('Preview');

    const rollback = await adapter.runAction(ctx, ident, { action: 'rollback', params: {} });
    expect(rollback.reference).toBe(firstProd);
    expect(api.calls.at(-1)!.path).toBe(`/v1/projects/${created.providerResourceId}/rollback/${firstProd}`);

    await adapter.runAction(ctx, ident, { action: 'promote', params: { deploymentId: 'dpl_abc' } });
    expect(api.calls.at(-1)!.path).toBe(`/v10/projects/${created.providerResourceId}/promote/dpl_abc`);

    const purge = await adapter.runAction(ctx, ident, { action: 'purge-cache', params: {} });
    expect(purge.status).toBe('completed');
    expect(api.calls.at(-1)!.body).toEqual({ tags: ['*'] });
    expect(api.calls.at(-1)!.query.get('projectIdOrName')).toBe(created.providerResourceId);
  });
});

describe('VercelAdapter.validateTarget', () => {
  it('rejects a malformed team id and a non Vercel region without calling the API', async () => {
    const { api, adapter, ctx } = setup({ teamId: 'acme' });
    const bad = await adapter.validateTarget({ ...ctx, region: 'eu-west-1' });
    expect(bad.ok).toBe(false);
    expect(bad.checks.filter((c) => c.status === 'error').map((c) => c.name)).toEqual(['Team', 'Region']);
    expect(api.calls).toEqual([]);
  });

  it('confirms the token and reports the identity', async () => {
    const { adapter, ctx } = setup({ teamId: 'team_abc123' });
    const result = await adapter.validateTarget(ctx);
    expect(result).toMatchObject({ ok: true, identity: 'acme' });
  });

  it('explains a token that is not scoped to the team', async () => {
    const { api, adapter, ctx } = setup({ teamId: 'team_abc123' });
    api.failures.set('GET /v2/teams/team_abc123', { status: 403, body: { error: { code: 'forbidden', message: 'Not authorized' } } });
    const result = await adapter.validateTarget(ctx);
    expect(result.ok).toBe(false);
    expect(result.checks.at(-1)).toMatchObject({ name: 'Team access', status: 'error' });
    expect(result.checks.at(-1)!.message).toContain('scope');
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});

// Vercel plans nothing ahead (no planResource), so there is no replacing request to check.
runAdapterContract('VercelAdapter', () => {
  const { adapter, ctx } = setup();
  return { adapter, context: ctx, sampleRequest: request(), secrets: [TOKEN] };
});
