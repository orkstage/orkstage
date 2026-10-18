// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { demo, member, startApi, tenant, type Api, type Caller } from './harness.js';

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

describe('notification preferences (open item 16)', () => {
  it('everything is on until a person turns it off, for themselves only', async () => {
    const t = await tenant(admin, 'ntf');
    const owner = await api.as((await member(api.prisma, t.id, 'CustomerOwner')).email);
    const initial = await owner.get('/me/notification-preferences');
    expect(initial.status).toBe(200);
    expect(initial.body.events).toContain('incident.opened');
    expect(initial.body.preferences.every((p: { enabled: boolean }) => p.enabled)).toBe(true);

    const saved = await owner.request('PUT', '/me/notification-preferences', { preferences: [{ event: 'deployment.started', channel: 'email', enabled: false }] });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const pref = (r: { body: { preferences: { event: string; channel: string; enabled: boolean }[] } }, event: string, channel: string) =>
      r.body.preferences.find((p) => p.event === event && p.channel === channel)?.enabled;
    expect(pref(saved, 'deployment.started', 'email')).toBe(false);
    expect(pref(saved, 'deployment.started', 'in_app')).toBe(true);

    const other = await api.as((await member(api.prisma, t.id, 'CustomerAdmin')).email);
    expect(pref(await other.get('/me/notification-preferences'), 'deployment.started', 'email')).toBe(true);

    expect((await owner.request('PUT', '/me/notification-preferences', { preferences: [{ event: 'no.such.event', channel: 'email', enabled: false }] })).status).toBe(422);
    expect((await owner.request('PUT', '/me/notification-preferences', { preferences: [{ event: 'deployment.started', channel: 'sms', enabled: false }] })).status).toBe(400);
  });
});

describe('chat webhooks (open item 16)', () => {
  it('Slack and Teams endpoints must point at their own hosts', async () => {
    const t = await tenant(admin, 'ntf');
    const owner = await api.as((await member(api.prisma, t.id, 'CustomerOwner')).email);
    const wrong = await owner.post('/webhooks', { tenantId: t.id, url: 'https://example.com/hook', events: ['incident.opened'], format: 'SLACK' });
    expect(wrong.status).toBe(422);
    expect(wrong.body.error.code).toBe('WEBHOOK_HOST_MISMATCH');
    const teams = await owner.post('/webhooks', { tenantId: t.id, url: 'https://hooks.slack.com/services/T0/B0/x', events: ['incident.opened'], format: 'TEAMS' });
    expect(teams.status).toBe(422);
  });
});
