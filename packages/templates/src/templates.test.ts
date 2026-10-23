// SPDX-License-Identifier: AGPL-3.0-only
import type { TenantFeatures, TenantLimits } from '@orkstage/domain';
import { describe, expect, it } from 'vitest';
import {
  applyVariables,
  buildDependencyGraph,
  dependentsOf,
  parseTemplate,
  topologicalLevels,
  validateSemantics,
  validateTemplate,
  type EnvironmentTemplate,
} from './index.js';
import { loadBuiltinTemplates, loadMarketplaceTemplates } from './builtin.js';

const builtins = loadBuiltinTemplates();
const byName = (name: string): EnvironmentTemplate => {
  const found = builtins.find((b) => b.template.metadata.name === name);
  if (!found) throw new Error(`missing builtin ${name}`);
  return found.template;
};


const ALL_ON: TenantFeatures = { multiCloud: true, multiRegion: true, autoscaling: true, customDomains: true };
/** What the size tags of the built in templates stand for: the limits the old plans of that name had. */
const SIZES: Record<'sandbox' | 'starter' | 'growth' | 'scale', { limits: TenantLimits; features: TenantFeatures }> = {
  sandbox: {
    limits: { maxServicesPerInstance: 4, maxVcpuPerInstance: 1, maxMemoryGiBPerInstance: 2, maxDatabaseGiBPerInstance: 10, maxReplicasPerService: 1, maxDomainsPerInstance: 1, maxBackupRetentionDays: 1 },
    features: { multiCloud: false, multiRegion: false, autoscaling: false, customDomains: false },
  },
  starter: {
    limits: { maxServicesPerInstance: 8, maxVcpuPerInstance: 4, maxMemoryGiBPerInstance: 8, maxDatabaseGiBPerInstance: 50, maxReplicasPerService: 2, maxDomainsPerInstance: 3, maxBackupRetentionDays: 7 },
    features: { multiCloud: false, multiRegion: false, autoscaling: false, customDomains: true },
  },
  growth: {
    limits: { maxServicesPerInstance: 20, maxVcpuPerInstance: 16, maxMemoryGiBPerInstance: 32, maxDatabaseGiBPerInstance: 250, maxReplicasPerService: 6, maxDomainsPerInstance: 10, maxBackupRetentionDays: 14 },
    features: { multiCloud: true, multiRegion: false, autoscaling: true, customDomains: true },
  },
  scale: {
    limits: { maxServicesPerInstance: 100, maxVcpuPerInstance: 256, maxMemoryGiBPerInstance: 512, maxDatabaseGiBPerInstance: 4000, maxReplicasPerService: 50, maxDomainsPerInstance: 100, maxBackupRetentionDays: 35 },
    features: ALL_ON,
  },
};

describe('built-in templates', () => {
  it('ships the required defaults', () => {
    expect(builtins.map((b) => b.template.metadata.name)).toEqual([
      'free-validation',
      'sandbox-min-cost',
      'starter-standard',
      'growth-standard',
      'scale-custom',
      'multicloud-reference',
      'web-platforms',
      'portable-starter',
    ]);
  });

  it.each(builtins.map((b) => [b.template.metadata.name, b] as const))(
    '%s is valid with no warnings, and fits the limits its size tag stands for',
    (_name, { source, template }) => {
      expect(validateTemplate(source).issues).toEqual([]);
      const size = template.metadata.tags.find((t): t is keyof typeof SIZES => t in SIZES);
      expect(size, 'a size tag').toBeDefined();
      const result = validateTemplate(source, SIZES[size!]);
      expect(result.issues, `${size}: ${JSON.stringify(result.issues)}`).toEqual([]);
    },
  );
});

describe('schema validation', () => {
  it('reports invalid YAML', () => {
    const result = parseTemplate('foo: [unclosed');
    expect(result.ok).toBe(false);
  });

  it('reports schema errors with a path', () => {
    const result = validateTemplate({ apiVersion: 'platform/v1', kind: 'EnvironmentTemplate', metadata: {}, spec: {} });
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.path?.startsWith('metadata'))).toBe(true);
  });
});

describe('semantic validation', () => {
  const base = structuredClone(byName('free-validation'));

  it('rejects unknown dependencies', () => {
    const t = structuredClone(base);
    t.spec.resources[2]!.dependsOn = ['ghost'];
    expect(validateTemplate(t).issues.map((i) => i.code)).toContain('UNKNOWN_DEPENDENCY');
  });

  it('rejects dependency cycles', () => {
    const t = structuredClone(base);
    const db = t.spec.resources.find((r) => r.id === 'database')!;
    db.dependsOn = ['api']; // api already depends on database via connectivity
    expect(validateTemplate(t).issues.map((i) => i.code)).toContain('DEPENDENCY_CYCLE');
  });

  it('rejects unknown placement slots', () => {
    const t = structuredClone(base);
    t.spec.resources[0]!.placement = 'elsewhere';
    expect(validateTemplate(t).issues.map((i) => i.code)).toContain('UNKNOWN_PLACEMENT');
  });
});

describe('tenant limits and deprecated fields', () => {

  it('accepts and ignores spec.plans and metadata.profile, with deprecation warnings (ADR 0007)', () => {
    const t = { ...structuredClone(byName('growth-standard')) };
    t.spec.plans = ['FREE'];
    t.metadata.profile = 'growth';
    const result = validateTemplate(t, SIZES.growth);
    expect(result.valid).toBe(true);
    expect(result.issues.map((i) => [i.code, i.severity])).toEqual([
      ['PLANS_DEPRECATED', 'warning'],
      ['PROFILE_DEPRECATED', 'warning'],
    ]);
  });

  it('rejects malformed tags', () => {
    const t = structuredClone(byName('growth-standard'));
    t.metadata.tags = ['Not-Valid'];
    expect(validateTemplate(t).issues.map((i) => i.code)).toContain('SCHEMA_INVALID');
  });

  it('enforces the limits and features of the tenant it is checked for', () => {
    const t = structuredClone(byName('growth-standard'));
    const codes = validateTemplate(t, SIZES.starter).issues.map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(['LIMIT_MAX_VCPU', 'AUTOSCALING_DISABLED', 'LIMIT_BACKUP_RETENTION']));
    expect(validateTemplate(t, { limits: {}, features: ALL_ON }).issues).toEqual([]);
  });
});

describe('dependency graph', () => {
  it('orders network and data before compute, and DNS last', () => {
    const levels = topologicalLevels(buildDependencyGraph(byName('starter-standard')));
    const levelOf = (id: string) => levels.findIndex((l) => l.includes(id));
    expect(levelOf('network')).toBeLessThan(levelOf('database'));
    expect(levelOf('database')).toBeLessThan(levelOf('api'));
    expect(levelOf('registry')).toBeLessThan(levelOf('api'));
    expect(levelOf('ingress')).toBeLessThan(levelOf('api'));
    expect(levelOf('ingress')).toBeLessThan(levelOf('dns'));
  });

  it('does not tie cross-placement resources to another slot network', () => {
    const graph = buildDependencyGraph(byName('multicloud-reference'));
    expect(graph.get('database')!.has('network')).toBe(false);
    expect(graph.get('api')!.has('network')).toBe(true);
  });

  it('finds everything that must be skipped when a resource fails', () => {
    const graph = buildDependencyGraph(byName('multicloud-reference'));
    const affected = dependentsOf(graph, 'storage');
    expect([...affected].sort()).toEqual(['api']);
    expect(affected.has('database')).toBe(false);
  });
});

describe('variables', () => {
  it('applies values onto the target field', () => {
    const { template, issues } = applyVariables(byName('starter-standard'), { apiReplicas: 2 });
    expect(issues).toEqual([]);
    expect(template.spec.resources.find((r) => r.id === 'api')).toMatchObject({ replicas: 2 });
  });

  it('rejects out-of-range, wrong-type and undeclared variables', () => {
    const t = byName('starter-standard');
    expect(applyVariables(t, { apiReplicas: 9 }).issues[0]?.code).toBe('VARIABLE_RANGE');
    expect(applyVariables(t, { apiReplicas: 'two' }).issues[0]?.code).toBe('VARIABLE_TYPE');
    expect(applyVariables(t, { nope: 1 }).issues[0]?.code).toBe('UNKNOWN_VARIABLE');
    expect(applyVariables(t, { databaseSize: 'huge' }).issues[0]?.code).toBe('VARIABLE_NOT_ALLOWED');
  });

  it('can toggle optional resources', () => {
    const t = byName('sandbox-min-cost');
    const off = buildDependencyGraph(applyVariables(t, {}).template);
    const on = buildDependencyGraph(applyVariables(t, { enableCache: true }).template);
    expect(off.has('cache')).toBe(false);
    expect(on.get('api')!.has('cache')).toBe(true);
  });
});

describe('marketplace templates', () => {
  const seeds = loadMarketplaceTemplates();

  it('ships the curated listings, each matching its template', () => {
    expect(seeds.map((s) => s.slug)).toEqual(['disaster-recovery-warm-standby', 'payment-gateway', 'ecommerce-storefront', 'logistics-tracking', 'last-mile-delivery']);
    for (const s of seeds) {
      expect(s.template.metadata.name).toBe(s.slug);
      expect(s.categories.length).toBeGreaterThan(0);
    }
  });

  it.each(seeds.map((s) => [s.slug, s] as const))('%s passes semantic validation', (_slug, s) => {
    expect(validateSemantics(s.template)).toEqual([]);
  });
});
