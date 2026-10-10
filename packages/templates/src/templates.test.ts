import { DEFAULT_ENTITLEMENTS, type PlanCode } from '@orkstage/domain';
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
    ]);
  });

  it.each(builtins.map((b) => [b.template.metadata.name, b] as const))(
    '%s is valid on every plan it declares',
    (_name, { source, template }) => {
      for (const plan of template.spec.plans) {
        const result = validateTemplate(source, { code: plan, entitlements: DEFAULT_ENTITLEMENTS[plan] });
        expect(result.issues, `${plan}: ${JSON.stringify(result.issues)}`).toEqual([]);
      }
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

describe('plan compatibility', () => {
  const check = (name: string, plan: PlanCode) =>
    validateTemplate(byName(name), { code: plan, entitlements: DEFAULT_ENTITLEMENTS[plan] }).issues.map((i) => i.code);

  it('rejects templates on plans they do not support', () => {
    expect(check('growth-standard', 'FREE')).toContain('PLAN_NOT_ALLOWED');
  });

  it('enforces resource limits even when the plan list is bypassed', () => {
    const t = structuredClone(byName('growth-standard'));
    t.spec.plans = ['STARTER'];
    const codes = validateTemplate(t, { code: 'STARTER', entitlements: DEFAULT_ENTITLEMENTS.STARTER }).issues.map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(['PLAN_MAX_CPU', 'PLAN_NO_AUTOSCALING', 'PLAN_BACKUP_RETENTION']));
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
