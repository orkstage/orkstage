import {
  connectivityRequirement,
  containerServiceResource,
  dnsResource,
  environmentTemplate,
  ingressResource,
  networkResource,
  objectStorageResource,
  postgresResource,
  queueResource,
  redisResource,
  registryResource,
  RESOURCE_TYPES,
  type ResourceType,
  type ValidationIssue,
} from '@co/templates';

/*
 * The builder edits the template document as plain data (the same shape the YAML has). It is
 * deliberately loose: a draft may be temporarily invalid while the user works; validation is a
 * separate, continuous step. Every edit returns a new object (undo/redo keeps snapshots).
 */

export type Res = { id: string; type: string; placement?: string; dependsOn?: string[] } & Record<string, unknown>;
export interface Conn {
  from: string;
  to: string;
  protocol: string;
  port?: number;
  mode?: string;
}
export interface Slot {
  name: string;
  description?: string;
  providers?: string[];
}
export interface Var {
  name: string;
  type: 'number' | 'string' | 'boolean';
  default: string | number | boolean;
  min?: number;
  max?: number;
  allowed?: string[];
  description?: string;
  target: string;
}
export interface Draft {
  apiVersion: string;
  kind: string;
  metadata: { name: string; version: string; displayName: string; description?: string; nonProduction?: boolean; profile: string } & Record<string, unknown>;
  spec: {
    plans: string[];
    placements: Slot[];
    variables?: Var[];
    resources: Res[];
    connectivity?: Conn[];
    observability?: Record<string, boolean>;
  } & Record<string, unknown>;
}

export const RESOURCE_SCHEMAS = {
  network: networkResource,
  'compute.container-service': containerServiceResource,
  'container-registry': registryResource,
  'database.postgresql': postgresResource,
  'cache.redis': redisResource,
  queue: queueResource,
  'object-storage': objectStorageResource,
  ingress: ingressResource,
  dns: dnsResource,
} as const;
export { RESOURCE_TYPES, type ResourceType };

export const PROTOCOLS = connectivityRequirement.shape.protocol.options as readonly string[];
export const MODES = ['private-required', 'private-preferred', 'secure'] as const;
export const PROFILES = environmentTemplate.shape.metadata.shape.profile.options as readonly string[];
export const OBSERVABILITY_KEYS = ['logs', 'metrics', 'traces', 'uptime', 'alerts'] as const;
export const ID_PATTERN = /^[a-z][a-zA-Z0-9-]{0,39}$/;

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

/** Normalises any parsed YAML/JSON into the Draft shape without adding defaults. */
export function toDraft(input: unknown): Draft {
  const root = rec(input);
  const metadata = rec(root.metadata);
  const spec = rec(root.spec);
  return {
    ...root,
    apiVersion: typeof root.apiVersion === 'string' ? root.apiVersion : 'platform/v1',
    kind: typeof root.kind === 'string' ? root.kind : 'EnvironmentTemplate',
    metadata: {
      ...metadata,
      name: String(metadata.name ?? ''),
      version: String(metadata.version ?? '1.0.0'),
      displayName: String(metadata.displayName ?? ''),
      profile: String(metadata.profile ?? 'starter'),
    },
    spec: {
      ...spec,
      plans: arr<string>(spec.plans),
      placements: arr<Slot>(spec.placements).length ? arr<Slot>(spec.placements) : [{ name: 'primary' }],
      resources: arr<Res>(spec.resources),
      ...(spec.variables !== undefined ? { variables: arr<Var>(spec.variables) } : {}),
      ...(spec.connectivity !== undefined ? { connectivity: arr<Conn>(spec.connectivity) } : {}),
    },
  } as Draft;
}

/** A new template. The display name and slot description are passed in the active language. */
export function emptyDraft(text: { displayName: string; slotDescription: string }): Draft {
  return {
    apiVersion: 'platform/v1',
    kind: 'EnvironmentTemplate',
    metadata: { name: 'my-template', version: '1.0.0', displayName: text.displayName, description: '', profile: 'starter' },
    spec: { plans: ['STARTER'], placements: [{ name: 'primary', description: text.slotDescription }], resources: [], connectivity: [] },
  };
}

const clone = <T>(v: T): T => structuredClone(v);

/** Applies a mutation to a deep copy. */
export function edit(doc: Draft, fn: (d: Draft) => void): Draft {
  const next = clone(doc);
  fn(next);
  return next;
}

/** The schema default for a missing placement is "primary". */
export const placementOf = (r: Res, _d?: Draft) => r.placement ?? 'primary';

export function uniqueId(doc: Draft, base: string): string {
  const ids = new Set(doc.spec.resources.map((r) => r.id));
  if (!ids.has(base)) return base;
  for (let i = 2; ; i++) if (!ids.has(`${base}-${i}`)) return `${base}-${i}`;
}

/** A new resource with schema defaults: a minimal object parsed through the type's zod schema. */
export function newResource(doc: Draft, type: ResourceType, id: string, placement: string): Res {
  const services = doc.spec.resources.filter((r) => r.type === 'compute.container-service').map((r) => r.id);
  const ingresses = doc.spec.resources.filter((r) => r.type === 'ingress').map((r) => r.id);
  const minimal: Record<string, unknown> = { id, type, placement };
  if (type === 'compute.container-service') Object.assign(minimal, { image: 'catalog://sample-api', port: 8080, healthCheckPath: '/health' });
  if (type === 'ingress') minimal.routes = [{ service: services[0] ?? 'api' }];
  if (type === 'dns') minimal.target = ingresses[0] ?? 'ingress';
  const parsed = RESOURCE_SCHEMAS[type].safeParse(minimal);
  return (parsed.success ? parsed.data : minimal) as Res;
}

export function addResource(doc: Draft, type: ResourceType, placement: string): { doc: Draft; id: string } {
  const id = uniqueId(doc, defaultIdFor(type));
  return { doc: edit(doc, (d) => d.spec.resources.push(newResource(doc, type, id, placement))), id };
}

function defaultIdFor(type: ResourceType): string {
  return (
    {
      network: 'network',
      'compute.container-service': 'api',
      'container-registry': 'registry',
      'database.postgresql': 'database',
      'cache.redis': 'cache',
      queue: 'queue',
      'object-storage': 'storage',
      ingress: 'ingress',
      dns: 'dns',
    } as const
  )[type];
}

/** Renames a resource and every reference to it. */
export function renameResource(doc: Draft, from: string, to: string): Draft {
  return edit(doc, (d) => {
    for (const r of d.spec.resources) {
      if (r.id === from) r.id = to;
      if (r.dependsOn) r.dependsOn = r.dependsOn.map((x) => (x === from ? to : x));
      if (r.type === 'ingress') r.routes = arr<{ service: string }>(r.routes).map((rt) => (rt.service === from ? { ...rt, service: to } : rt));
      if (r.type === 'dns' && r.target === from) r.target = to;
    }
    for (const c of d.spec.connectivity ?? []) {
      if (c.from === from) c.from = to;
      if (c.to === from) c.to = to;
    }
    for (const v of d.spec.variables ?? []) {
      const [rid, field] = v.target.split('.');
      if (rid === from) v.target = `${to}.${field ?? ''}`;
    }
  });
}

/** Removes a resource and the relationships that point at it (variables are kept and flagged by validation). */
export function removeResource(doc: Draft, id: string): Draft {
  return edit(doc, (d) => {
    d.spec.resources = d.spec.resources.filter((r) => r.id !== id);
    for (const r of d.spec.resources) {
      if (r.dependsOn) r.dependsOn = r.dependsOn.filter((x) => x !== id);
      if (r.type === 'ingress') r.routes = arr<{ service: string }>(r.routes).filter((rt) => rt.service !== id);
    }
    if (d.spec.connectivity) d.spec.connectivity = d.spec.connectivity.filter((c) => c.from !== id && c.to !== id);
  });
}

export type EdgeKind = 'connectivity' | 'dependsOn' | 'route' | 'dns';
export interface DraftEdge {
  id: string;
  kind: EdgeKind;
  from: string;
  to: string;
  /** Connectivity: protocol and port. Route: the path prefix. Shown through `useEdgeLabel()`. */
  label?: string;
  index?: number;
}

export function draftEdges(doc: Draft): DraftEdge[] {
  const ids = new Set(doc.spec.resources.map((r) => r.id));
  const out: DraftEdge[] = [];
  (doc.spec.connectivity ?? []).forEach((c, index) => {
    if (ids.has(c.from) && ids.has(c.to)) out.push({ id: `conn:${index}`, kind: 'connectivity', from: c.from, to: c.to, index, label: `${c.protocol}${c.port ? `:${c.port}` : ''}` });
  });
  for (const r of doc.spec.resources) {
    for (const dep of r.dependsOn ?? []) if (ids.has(dep)) out.push({ id: `dep:${r.id}>${dep}`, kind: 'dependsOn', from: r.id, to: dep });
    if (r.type === 'ingress') {
      for (const rt of arr<{ service: string; pathPrefix?: string }>(r.routes)) {
        if (ids.has(rt.service)) out.push({ id: `route:${r.id}>${rt.service}`, kind: 'route', from: r.id, to: rt.service, label: rt.pathPrefix ?? '/' });
      }
    }
    if (r.type === 'dns' && typeof r.target === 'string' && ids.has(r.target)) out.push({ id: `dns:${r.id}>${r.target}`, kind: 'dns', from: r.id, to: r.target });
  }
  return out;
}

export function edgeKindsFor(doc: Draft, from: string, to: string): EdgeKind[] {
  const a = doc.spec.resources.find((r) => r.id === from);
  const b = doc.spec.resources.find((r) => r.id === to);
  const kinds: EdgeKind[] = [];
  if (a?.type === 'ingress' && b?.type === 'compute.container-service') kinds.push('route');
  if (a?.type === 'dns' && b?.type === 'ingress') kinds.push('dns');
  kinds.push('connectivity', 'dependsOn');
  return kinds;
}

export function guessProtocol(doc: Draft, to: string): string {
  const t = doc.spec.resources.find((r) => r.id === to)?.type;
  if (t === 'database.postgresql') return 'postgres';
  if (t === 'cache.redis') return 'redis';
  if (t === 'queue') return 'amqp';
  return 'https';
}

export function addEdge(doc: Draft, kind: EdgeKind, from: string, to: string, data: { protocol?: string; port?: number; mode?: string; pathPrefix?: string } = {}): Draft {
  return edit(doc, (d) => {
    const a = d.spec.resources.find((r) => r.id === from);
    if (!a || from === to) return;
    if (kind === 'connectivity') {
      const c: Conn = { from, to, protocol: data.protocol ?? 'https' };
      if (data.port) c.port = data.port;
      if (data.mode) c.mode = data.mode;
      d.spec.connectivity = [...(d.spec.connectivity ?? []), c];
    } else if (kind === 'dependsOn') {
      a.dependsOn = [...new Set([...(a.dependsOn ?? []), to])];
    } else if (kind === 'route') {
      const routes = arr<{ service: string; pathPrefix?: string }>(a.routes).filter((r) => r.service !== to);
      a.routes = [...routes, { service: to, ...(data.pathPrefix && data.pathPrefix !== '/' ? { pathPrefix: data.pathPrefix } : {}) }];
    } else if (kind === 'dns') {
      a.target = to;
    }
  });
}

export function removeEdge(doc: Draft, edge: DraftEdge): Draft {
  return edit(doc, (d) => {
    const a = d.spec.resources.find((r) => r.id === edge.from);
    if (edge.kind === 'connectivity' && edge.index !== undefined) d.spec.connectivity = (d.spec.connectivity ?? []).filter((_, i) => i !== edge.index);
    if (edge.kind === 'dependsOn' && a) a.dependsOn = (a.dependsOn ?? []).filter((x) => x !== edge.to);
    if (edge.kind === 'route' && a) a.routes = arr<{ service: string }>(a.routes).filter((r) => r.service !== edge.to);
    if (edge.kind === 'dns' && a) a.target = '';
  });
}

/** Converts a connectivity edge to a plain dependency and back. */
export function toggleEdgeKind(doc: Draft, edge: DraftEdge): Draft {
  if (edge.kind === 'connectivity') return addEdge(removeEdge(doc, edge), 'dependsOn', edge.from, edge.to);
  if (edge.kind === 'dependsOn') return addEdge(removeEdge(doc, edge), 'connectivity', edge.from, edge.to, { protocol: guessProtocol(doc, edge.to), mode: 'private-preferred' });
  return doc;
}

export function addLane(doc: Draft): { doc: Draft; name: string } {
  const names = new Set(doc.spec.placements.map((p) => p.name));
  let name = 'slot';
  for (let i = 2; names.has(name); i++) name = `slot-${i}`;
  return { doc: edit(doc, (d) => d.spec.placements.push({ name, providers: [] })), name };
}

export function renameLane(doc: Draft, from: string, to: string): Draft {
  return edit(doc, (d) => {
    for (const p of d.spec.placements) if (p.name === from) p.name = to;
    for (const r of d.spec.resources) {
      // Resources without an explicit placement implicitly use "primary" (the schema default).
      if (placementOf(r) === from) r.placement = to;
    }
  });
}

export function laneIsEmpty(doc: Draft, name: string): boolean {
  return !doc.spec.resources.some((r) => placementOf(r, doc) === name);
}

/** Next version for a save: keeps the draft's version if it is greater than all, else bumps the patch of the highest. */
export function nextVersion(draftVersion: string, existing: string[]): string {
  const parse = (v: string) => (/^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null);
  const cmp = (a: number[], b: number[]) => a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!;
  const all = existing.map(parse).filter((v): v is number[] => v !== null);
  if (all.length === 0) return parse(draftVersion) ? draftVersion : '1.0.0';
  const max = all.sort(cmp)[all.length - 1]!;
  const mine = parse(draftVersion);
  if (mine && cmp(mine, max) > 0) return draftVersion;
  return `${max[0]}.${max[1]}.${max[2]! + 1}`;
}

export type IssueTarget = { kind: 'resource'; id: string } | { kind: 'lane'; name: string } | { kind: 'template' };

/** Maps a validation issue path (zod index paths or semantic id paths) to a canvas element. */
export function issueTarget(issue: Pick<ValidationIssue, 'path'>, doc: Draft): IssueTarget {
  const parts = (issue.path ?? '').split('.');
  if (parts[0] === 'spec' && parts[1] === 'resources' && parts[2] !== undefined) {
    const key = parts[2];
    const byIndex = /^\d+$/.test(key) ? doc.spec.resources[Number(key)] : undefined;
    const id = byIndex?.id ?? (doc.spec.resources.some((r) => r.id === key) ? key : undefined);
    if (id) return { kind: 'resource', id };
  }
  if (parts[0] === 'spec' && parts[1] === 'placements' && parts[2] !== undefined && /^\d+$/.test(parts[2])) {
    const lane = doc.spec.placements[Number(parts[2])];
    if (lane) return { kind: 'lane', name: lane.name };
  }
  return { kind: 'template' };
}
