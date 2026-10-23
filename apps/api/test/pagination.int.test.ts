// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { demo, startApi, tenant, type Api, type Caller } from './harness.js';

let api: Api;
let admin: Caller;

beforeAll(async () => {
  api = await startApi();
  const ctx = await demo(api.prisma);
  admin = await api.as(ctx.admin);
});

afterAll(async () => {
  await api?.close();
});

interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** Every page of a list, following nextCursor. */
async function all<T>(path: string, limit: number): Promise<T[][]> {
  const pages: T[][] = [];
  let cursor: string | null = null;
  do {
    const sep = path.includes('?') ? '&' : '?';
    const res = await admin.get<Page<T>>(`${path}${sep}limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    pages.push(res.body.items);
    cursor = res.body.nextCursor;
  } while (cursor && pages.length < 50);
  return pages;
}

describe('pagination and sort on every list (open item 21)', () => {
  it('pages tenants by name without gaps or repeats, in both directions', async () => {
    // Other test files create tenants at the same time: compare only the ones created here.
    const mine = new Set<string>();
    for (let i = 0; i < 3; i++) mine.add((await tenant(admin, 'pg')).id);
    const pages = await all<{ id: string; name: string }>('/tenants?sort=name', 2);
    const ids = pages.flat().map((t) => t.id);
    expect(pages.length).toBeGreaterThan(1);
    expect(new Set(ids).size).toBe(ids.length);
    const ascending = ids.filter((id) => mine.has(id));
    expect(ascending).toHaveLength(3);

    const descending = (await all<{ id: string }>('/tenants?sort=-name', 100)).flat().map((t) => t.id).filter((id) => mine.has(id));
    expect(descending).toEqual([...ascending].reverse());
  });

  it('returns pages for templates, cloud targets, API keys and webhooks', async () => {
    for (const path of ['/templates', '/cloud/targets', '/api-keys', '/webhooks']) {
      const res = await admin.get<Page<unknown>>(`${path}?limit=1`);
      expect(res.status, `${path} ${JSON.stringify(res.body)}`).toBe(200);
      expect(Array.isArray(res.body.items), path).toBe(true);
      expect(res.body.items.length, path).toBeLessThanOrEqual(1);
      expect('nextCursor' in res.body, path).toBe(true);
    }
  });

  it('refuses a sort field the list does not offer', async () => {
    const res = await admin.get('/tenants?sort=password');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_SORT');
  });
});
