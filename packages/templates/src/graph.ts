// SPDX-License-Identifier: AGPL-3.0-only
import type { EnvironmentTemplate, TemplateResource } from './schema.js';

/** Resource types that live inside a network and therefore depend on it implicitly. */
const NETWORKED_TYPES = new Set<TemplateResource['type']>([
  'compute.container-service',
  'database.postgresql',
  'cache.redis',
  'ingress',
]);

/** Resources that will actually be provisioned. */
export function activeResources(template: EnvironmentTemplate): TemplateResource[] {
  return template.spec.resources.filter((r) => r.enabled);
}

/**
 * Builds the dependency graph over enabled resources: resource id → ids it depends on. Edges come from explicit
 * `dependsOn`, connectivity (`from` depends on `to`), ingress routes (the routed service depends
 * on its ingress), DNS targets, the network
 * of the same placement slot, and registries (compute pulls images from them).
 */
export function buildDependencyGraph(template: EnvironmentTemplate): Map<string, Set<string>> {
  const resources = activeResources(template);
  const graph = new Map<string, Set<string>>(resources.map((r) => [r.id, new Set<string>()]));
  for (const r of resources) for (const dep of r.dependsOn) add(r.id, dep);
  function add(from: string, to: string) {
    if (from !== to && graph.has(from) && graph.has(to)) graph.get(from)!.add(to);
  }
  for (const c of template.spec.connectivity) add(c.from, c.to);

  const networks = resources.filter((r) => r.type === 'network');
  const registries = resources.filter((r) => r.type === 'container-registry');

  for (const r of resources) {
    if (NETWORKED_TYPES.has(r.type)) {
      for (const n of networks) if (n.placement === r.placement) add(r.id, n.id);
    }
    if (r.type === 'compute.container-service') for (const reg of registries) add(r.id, reg.id);
    // A service attaches itself to its ingress (target group / route), so the ingress must
    // exist first. Real providers enforce this (e.g. ECS rejects target groups without a load
    // balancer), so it is modelled here rather than per adapter.
    if (r.type === 'ingress') for (const route of r.routes) add(route.service, r.id);
    if (r.type === 'dns') add(r.id, r.target);
  }
  return graph;
}

export class DependencyCycleError extends Error {
  constructor(readonly cycle: string[]) {
    super(`Dependency cycle detected: ${cycle.join(' → ')}`);
  }
}

/**
 * Groups resources into execution levels. Everything in one level can run in parallel; each
 * level depends only on earlier levels. Throws on cycles.
 */
export function topologicalLevels(graph: Map<string, Set<string>>): string[][] {
  const remaining = new Map([...graph].map(([k, v]) => [k, new Set(v)]));
  const levels: string[][] = [];
  while (remaining.size > 0) {
    const ready = [...remaining].filter(([, deps]) => deps.size === 0).map(([k]) => k).sort();
    if (ready.length === 0) throw new DependencyCycleError(findCycle(remaining));
    levels.push(ready);
    for (const id of ready) remaining.delete(id);
    for (const deps of remaining.values()) for (const id of ready) deps.delete(id);
  }
  return levels;
}

function findCycle(graph: Map<string, Set<string>>): string[] {
  const visiting = new Set<string>();
  const stack: string[] = [];
  const visit = (node: string): string[] | undefined => {
    if (visiting.has(node)) return [...stack.slice(stack.indexOf(node)), node];
    visiting.add(node);
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      const found = visit(next);
      if (found) return found;
    }
    stack.pop();
    visiting.delete(node);
    return undefined;
  };
  for (const node of graph.keys()) {
    const cycle = visit(node);
    if (cycle) return cycle;
  }
  return [...graph.keys()];
}

/** All transitive dependents of `id` (resources that must be skipped if `id` fails). */
export function dependentsOf(graph: Map<string, Set<string>>, id: string): Set<string> {
  const result = new Set<string>();
  const queue = [id];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const [node, deps] of graph) {
      if (deps.has(current) && !result.has(node)) {
        result.add(node);
        queue.push(node);
      }
    }
  }
  return result;
}
