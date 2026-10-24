// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { ACTION_CATALOG, catalogAction, catalogActionFor, minimumRoleFor, releaseSettings, roleAtLeast, stricterRole } from './actions.js';

describe('action catalog (ADR 0009)', () => {
  it('maps a provider name to the catalog action of the resource type', () => {
    expect(catalogActionFor('restart', 'compute.container-service', 'azure')?.action.id).toBe('service.restart');
    expect(catalogActionFor('restart', 'database.postgresql', 'supabase')?.action.id).toBe('database.reboot');
    expect(catalogActionFor('backup', 'database.postgresql', 'supabase')?.action.id).toBe('database.snapshot');
    const own = catalogActionFor('service.scale', 'compute.container-service', 'aws');
    expect(own?.action.id).toBe('service.scale');
    expect(own?.alias).toBeUndefined();
  });

  it('keeps provider bound aliases to their provider, with their parameter names', () => {
    expect(catalogActionFor('scale', 'compute.container-service', 'render')?.alias?.params).toEqual({ replicas: 'numInstances' });
    expect(catalogActionFor('scale', 'compute.container-service', 'aws')).toBeUndefined();
    expect(catalogActionFor('rollback', 'web.frontend', 'vercel')?.alias?.params).toEqual({ deployment: 'deploymentId' });
    expect(catalogActionFor('suspend', 'compute.container-service', 'render')).toBeUndefined();
  });

  it('asks developers for safe actions and admins for everything else; templates only raise it', () => {
    expect(minimumRoleFor('safe')).toBe('CustomerDeveloper');
    expect(minimumRoleFor('disruptive')).toBe('CustomerAdmin');
    expect(minimumRoleFor(undefined)).toBe('CustomerAdmin');
    expect(stricterRole('CustomerAdmin', 'CustomerDeveloper')).toBe('CustomerAdmin');
    expect(stricterRole('CustomerDeveloper', 'CustomerOwner')).toBe('CustomerOwner');
    expect(roleAtLeast('CustomerOwner', 'CustomerAdmin')).toBe(true);
    expect(roleAtLeast('CustomerViewer', 'CustomerDeveloper')).toBe(false);
  });

  it('runs releases and rollbacks as platform deployments, disruptive and reversible (round 2)', () => {
    for (const id of ['release.canary', 'release.blueGreen', 'release.rollback']) {
      expect(catalogAction(id)).toMatchObject({ platform: true, risk: 'disruptive', reversible: true });
    }
    // Providers with their own rollback keep it.
    expect(catalogActionFor('rollback', 'web.frontend', 'vercel')?.action.id).toBe('release.rollback');
    expect(catalogAction('release.canary')?.params.map((p) => p.name)).toEqual(['trafficPercent', 'bakeMinutes']);
  });

  it('merges release settings: template, then the deployment; canaries always get a bake period', () => {
    expect(releaseSettings()).toEqual({ strategy: 'rolling', trafficPercent: 10, bakeMinutes: 0, autoRollback: true });
    expect(releaseSettings({ strategy: 'canary', trafficPercent: 20 })).toMatchObject({ strategy: 'canary', trafficPercent: 20, bakeMinutes: 15 });
    expect(releaseSettings({ strategy: 'blueGreen', bakeMinutes: 30 }, { bakeMinutes: undefined, autoRollback: false })).toMatchObject({ bakeMinutes: 30, autoRollback: false });
    expect(releaseSettings({ bakeMinutes: 10 }, { strategy: 'rolling', bakeMinutes: 0 }).bakeMinutes).toBe(0);
  });

  it('has unique ids, a risk and at least one resource type per action', () => {
    expect(new Set(ACTION_CATALOG.map((a) => a.id)).size).toBe(ACTION_CATALOG.length);
    for (const a of ACTION_CATALOG) {
      expect(a.id).toMatch(/^[a-z]+\.[a-zA-Z]+$/);
      expect(a.resourceTypes.length).toBeGreaterThan(0);
    }
  });
});
