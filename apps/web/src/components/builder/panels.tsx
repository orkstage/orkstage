'use client';

import { CLOUD_PROVIDERS, PLAN_CODES } from '@co/domain/core';
import { parseTemplate, type ValidationIssue } from '@co/templates';
import { Trash2 } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { cn } from '@/lib/utils';
import { RESOURCE_TYPE_META, ResourceIcon } from '../resource-icon';
import { Button } from '../ui/button';
import { Dialog } from '../ui/dialog';
import { Field, Input } from '../ui/input';
import { Disclosure } from '../ui/page-header';
import { Select } from '../ui/select';
import { Textarea } from '../ui/textarea';
import { NumberInput, SchemaField, TextInput, unwrap } from './fields';
import {
  draftEdges,
  edgeKindsFor,
  guessProtocol,
  ID_PATTERN,
  laneIsEmpty,
  MODES,
  OBSERVABILITY_KEYS,
  placementOf,
  PROFILES,
  PROTOCOLS,
  renameLane,
  renameResource,
  RESOURCE_SCHEMAS,
  toDraft,
  type Draft,
  type DraftEdge,
  type EdgeKind,
  type Res,
  type ResourceType,
  type Slot,
  type Var,
} from './model';

export type Commit = (next: Draft, coalesceKey?: string) => void;

export function yamlOf(doc: Draft): string {
  return stringifyYaml(doc, { lineWidth: 0 });
}

const SKIP = new Set(['id', 'type', 'placement', 'dependsOn', 'routes', 'target', 'implementation', 'enabled', 'overrides']);

function setField(res: Res, key: string, value: unknown): Res {
  const next = { ...res };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next;
}

function IssueList({ issues }: { issues: ValidationIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <ul className="space-y-1">
      {issues.map((i, n) => (
        <li key={n} className={cn('rounded border-l-2 bg-surface-2 px-2 py-1 text-xs', i.severity === 'error' ? 'border-danger' : 'border-warn')}>
          {i.message}
        </li>
      ))}
    </ul>
  );
}

export function ResourceInspector({ doc, res, commit, readOnly, issues, onDelete }: { doc: Draft; res: Res; commit: Commit; readOnly: boolean; issues: ValidationIssue[]; onDelete: () => void }) {
  const schema = RESOURCE_SCHEMAS[res.type as ResourceType];
  const meta = RESOURCE_TYPE_META[res.type];
  const base = useId();
  const [idText, setIdText] = useState(res.id);
  useEffect(() => setIdText(res.id), [res.id]);
  const idTaken = idText !== res.id && doc.spec.resources.some((r) => r.id === idText);
  const idError = !ID_PATTERN.test(idText) ? 'Start with a lowercase letter; letters, digits and dashes.' : idTaken ? 'Another resource already uses this id.' : null;

  const update = (key: string, value: unknown) => {
    const idx = doc.spec.resources.findIndex((r) => r.id === res.id);
    if (idx < 0) return;
    const next = structuredClone(doc);
    next.spec.resources[idx] = setField(res, key, value);
    commit(next, `res:${res.id}:${key}`);
  };
  const edges = draftEdges(doc).filter((e) => e.from === res.id || e.to === res.id);

  if (!schema) return <p className="text-sm text-fg-subtle">Unknown resource type “{res.type}”. Edit it in YAML.</p>;
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <ResourceIcon type={res.type} size={22} />
        <div>
          <p className="text-sm font-semibold">{meta?.label ?? res.type}</p>
          <p className="font-mono text-[11px] text-fg-subtle">{res.type}</p>
        </div>
      </div>
      <IssueList issues={issues} />
      <Field label="Id" htmlFor={`${base}-id`} hint="Referenced by edges and variables; renaming updates them." error={idText !== res.id ? idError : null}>
        <Input
          id={`${base}-id`}
          className="font-mono"
          value={idText}
          readOnly={readOnly}
          onChange={(e) => setIdText(e.target.value)}
          onBlur={() => {
            if (idText !== res.id && !idError) commit(renameResource(doc, res.id, idText));
            else setIdText(res.id);
          }}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
      </Field>
      <Field label="Placement slot" htmlFor={`${base}-placement`} hint="Or drag the node into another lane.">
        <Select id={`${base}-placement`} value={placementOf(res)} disabled={readOnly} onChange={(e) => update('placement', e.target.value)}>
          {doc.spec.placements.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
            </option>
          ))}
        </Select>
      </Field>
      {Object.entries(schema.shape)
        .filter(([k]) => !SKIP.has(k))
        .map(([k, s]) => (
          <SchemaField key={k} id={`${base}-${k}`} name={k} schema={s} value={res[k]} readOnly={readOnly} onChange={(v) => update(k, v)} />
        ))}

      <div className="rounded-md border border-border p-2.5 text-xs">
        <p className="mb-1 font-medium text-fg-muted">Relationships</p>
        {edges.length === 0 ? (
          <p className="text-fg-subtle">None. Drag from a node’s right handle to another node to connect them.</p>
        ) : (
          <ul className="space-y-0.5">
            {edges.map((e) => (
              <li key={e.id} className="font-mono text-[11px] text-fg-muted">
                {e.from} → {e.to} <span className="text-fg-subtle">({e.label})</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <Disclosure summary="Advanced">
        <SchemaField id={`${base}-implementation`} name="implementation" schema={schema.shape.implementation} value={res.implementation} readOnly={readOnly} onChange={(v) => update('implementation', v)} />
        <SchemaField id={`${base}-enabled`} name="enabled" schema={schema.shape.enabled} value={res.enabled} readOnly={readOnly} onChange={(v) => update('enabled', v)} />
        <SchemaField id={`${base}-overrides`} name="overrides" schema={schema.shape.overrides} value={res.overrides} readOnly={readOnly} onChange={(v) => update('overrides', v)} />
      </Disclosure>
      {!readOnly ? (
        <Button variant="danger-outline" size="sm" onClick={onDelete}>
          <Trash2 size={13} aria-hidden /> Remove resource
        </Button>
      ) : null}
    </div>
  );
}

export function LaneInspector({ doc, name, commit, readOnly, issues, onDelete }: { doc: Draft; name: string; commit: Commit; readOnly: boolean; issues: ValidationIssue[]; onDelete: () => void }) {
  const base = useId();
  const slot = doc.spec.placements.find((p) => p.name === name);
  const [text, setText] = useState(name);
  useEffect(() => setText(name), [name]);
  if (!slot) return null;
  const idx = doc.spec.placements.indexOf(slot);
  const taken = text !== name && doc.spec.placements.some((p) => p.name === text);
  const error = !ID_PATTERN.test(text) ? 'Start with a lowercase letter; letters, digits and dashes.' : taken ? 'Slot names must be unique.' : null;
  const providers = slot.providers ?? [];
  const set = (fn: (s: Slot) => void, key: string) => {
    const next = structuredClone(doc);
    fn(next.spec.placements[idx]!);
    commit(next, key);
  };
  const canDelete = doc.spec.placements.length > 1 && laneIsEmpty(doc, name);

  return (
    <div className="space-y-3">
      <div>
        <p className="text-sm font-semibold">Placement slot</p>
        <p className="text-xs text-fg-subtle">Each instance binds every slot to a cloud target and region, so one template can span several clouds.</p>
      </div>
      <IssueList issues={issues} />
      <Field label="Name" htmlFor={`${base}-name`} error={text !== name ? error : null}>
        <Input
          id={`${base}-name`}
          className="font-mono"
          value={text}
          readOnly={readOnly}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => {
            if (text !== name && !error) commit(renameLane(doc, name, text));
            else setText(name);
          }}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
      </Field>
      <Field label="Description" htmlFor={`${base}-desc`}>
        <TextInput id={`${base}-desc`} value={slot.description ?? ''} readOnly={readOnly} onChange={(v) => set((s) => (v ? (s.description = v) : delete s.description), `lane:${name}:desc`)} />
      </Field>
      <fieldset>
        <legend className="mb-1 text-xs font-medium text-fg-muted">Allowed providers</legend>
        <p className="mb-1.5 text-[11px] text-fg-subtle">None selected means any registered provider.</p>
        <div className="flex flex-wrap gap-1.5">
          {CLOUD_PROVIDERS.map((p) => {
            const on = providers.includes(p);
            return (
              <button
                key={p}
                type="button"
                aria-pressed={on}
                disabled={readOnly}
                onClick={() => set((s) => (s.providers = on ? providers.filter((x) => x !== p) : [...providers, p]), `lane:${name}:providers`)}
                className={cn('rounded-full border px-2.5 py-0.5 font-mono text-xs', on ? 'border-accent bg-accent/10 text-accent-ink' : 'border-border text-fg-muted hover:bg-surface-2')}
              >
                {p}
              </button>
            );
          })}
        </div>
      </fieldset>
      {!readOnly ? (
        <Button variant="danger-outline" size="sm" disabled={!canDelete} onClick={onDelete} title={canDelete ? undefined : 'Move or remove its resources first; a template needs at least one slot.'}>
          <Trash2 size={13} aria-hidden /> Remove slot
        </Button>
      ) : null}
    </div>
  );
}

export function EdgeInspector({
  doc,
  edge,
  commit,
  readOnly,
  onDelete,
  onToggleKind,
}: {
  doc: Draft;
  edge: DraftEdge;
  commit: Commit;
  readOnly: boolean;
  onDelete: () => void;
  onToggleKind: () => void;
}) {
  const base = useId();
  const conn = edge.kind === 'connectivity' && edge.index !== undefined ? doc.spec.connectivity?.[edge.index] : undefined;
  const ingress = edge.kind === 'route' ? doc.spec.resources.find((r) => r.id === edge.from) : undefined;
  const route = ingress ? (ingress.routes as { service: string; pathPrefix?: string }[] | undefined)?.find((r) => r.service === edge.to) : undefined;
  const titles: Record<EdgeKind, string> = { connectivity: 'Network connection', dependsOn: 'Dependency', route: 'Ingress route', dns: 'DNS target' };

  const setConn = (patch: Record<string, unknown>, key: string) => {
    if (edge.index === undefined) return;
    const next = structuredClone(doc);
    const c = next.spec.connectivity![edge.index]! as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(patch)) (v === undefined ? delete c[k] : (c[k] = v));
    commit(next, key);
  };

  return (
    <div className="space-y-3">
      <div>
        <p className="text-sm font-semibold">{titles[edge.kind]}</p>
        <p className="font-mono text-xs text-fg-muted">
          {edge.from} → {edge.to}
        </p>
      </div>
      {conn ? (
        <>
          <Field label="Protocol" htmlFor={`${base}-proto`}>
            <Select id={`${base}-proto`} value={conn.protocol} disabled={readOnly} onChange={(e) => setConn({ protocol: e.target.value }, `edge:${edge.id}:protocol`)}>
              {PROTOCOLS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Port" htmlFor={`${base}-port`} hint="Optional · 1–65535">
            <NumberInput id={`${base}-port`} value={conn.port} min={1} max={65535} step={1} readOnly={readOnly} onChange={(n) => setConn({ port: n }, `edge:${edge.id}:port`)} />
          </Field>
          <Field label="Mode" htmlFor={`${base}-mode`} hint="private-preferred falls back to TLS with allowlisting when a private link is not justified.">
            <Select id={`${base}-mode`} value={conn.mode ?? 'private-preferred'} disabled={readOnly} onChange={(e) => setConn({ mode: e.target.value }, `edge:${edge.id}:mode`)}>
              {MODES.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </Select>
          </Field>
        </>
      ) : null}
      {edge.kind === 'route' && ingress ? (
        <Field label="Path prefix" htmlFor={`${base}-path`} hint="Must start with /">
          <TextInput
            id={`${base}-path`}
            value={route?.pathPrefix ?? '/'}
            readOnly={readOnly}
            onChange={(v) => {
              const next = structuredClone(doc);
              const ing = next.spec.resources.find((r) => r.id === edge.from)!;
              ing.routes = (ing.routes as { service: string; pathPrefix?: string }[]).map((r) => (r.service === edge.to ? { ...r, pathPrefix: v } : r));
              commit(next, `edge:${edge.id}:path`);
            }}
          />
        </Field>
      ) : null}
      {!readOnly ? (
        <div className="flex flex-wrap gap-2">
          {edge.kind === 'connectivity' ? (
            <Button size="sm" onClick={onToggleKind}>
              Make it a dependency only
            </Button>
          ) : null}
          {edge.kind === 'dependsOn' ? (
            <Button size="sm" onClick={onToggleKind}>
              Make it a network connection
            </Button>
          ) : null}
          <Button size="sm" variant="danger-outline" onClick={onDelete}>
            <Trash2 size={13} aria-hidden /> Remove
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function TemplatePanel({ doc, commit, readOnly }: { doc: Draft; commit: Commit; readOnly: boolean }) {
  const base = useId();
  const md = doc.metadata;
  const setMeta = (key: string, value: unknown) => {
    const next = structuredClone(doc);
    const m = next.metadata as Record<string, unknown>;
    if (value === undefined || value === '') delete m[key];
    else m[key] = value;
    commit(next, `meta:${key}`);
  };
  const obs = { logs: true, metrics: true, traces: false, uptime: true, alerts: true, ...(doc.spec.observability ?? {}) };

  return (
    <div className="space-y-4">
      <section className="space-y-2.5">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">Metadata</h3>
        <Field label="Name" htmlFor={`${base}-name`} hint="Lowercase identifier">
          <TextInput id={`${base}-name`} className="font-mono" value={md.name} readOnly={readOnly} onChange={(v) => setMeta('name', v)} />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Version" htmlFor={`${base}-ver`} hint="Bumped on save if needed">
            <TextInput id={`${base}-ver`} className="font-mono" value={md.version} readOnly={readOnly} onChange={(v) => setMeta('version', v)} />
          </Field>
          <Field label="Profile" htmlFor={`${base}-profile`}>
            <Select id={`${base}-profile`} value={md.profile} disabled={readOnly} onChange={(e) => setMeta('profile', e.target.value)}>
              {PROFILES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Display name" htmlFor={`${base}-display`}>
          <TextInput id={`${base}-display`} value={md.displayName} readOnly={readOnly} onChange={(v) => setMeta('displayName', v)} />
        </Field>
        <Field label="Description" htmlFor={`${base}-desc`}>
          <Textarea id={`${base}-desc`} value={md.description ?? ''} readOnly={readOnly} onChange={(e) => setMeta('description', e.target.value)} />
        </Field>
        <label className="flex items-center justify-between text-xs font-medium text-fg-muted">
          Not for production
          <input type="checkbox" checked={md.nonProduction === true} disabled={readOnly} onChange={(e) => setMeta('nonProduction', e.target.checked || undefined)} />
        </label>
      </section>

      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">Plans</h3>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Plans this template is available on">
          {PLAN_CODES.map((p) => {
            const on = doc.spec.plans.includes(p);
            return (
              <button
                key={p}
                type="button"
                aria-pressed={on}
                disabled={readOnly}
                onClick={() => {
                  const next = structuredClone(doc);
                  next.spec.plans = on ? next.spec.plans.filter((x) => x !== p) : [...next.spec.plans, p];
                  commit(next);
                }}
                className={cn('rounded-full border px-2.5 py-0.5 text-xs', on ? 'border-accent bg-accent/10 text-accent-ink' : 'border-border text-fg-muted hover:bg-surface-2')}
              >
                {p}
              </button>
            );
          })}
        </div>
      </section>

      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">Observability</h3>
        {OBSERVABILITY_KEYS.map((k) => (
          <label key={k} className="flex items-center justify-between text-xs font-medium capitalize text-fg-muted">
            {k}
            <input
              type="checkbox"
              checked={obs[k] === true}
              disabled={readOnly}
              onChange={(e) => {
                const next = structuredClone(doc);
                next.spec.observability = { ...obs, [k]: e.target.checked };
                commit(next);
              }}
            />
          </label>
        ))}
      </section>

      <VariablesEditor doc={doc} commit={commit} readOnly={readOnly} />
    </div>
  );
}

function VariablesEditor({ doc, commit, readOnly }: { doc: Draft; commit: Commit; readOnly: boolean }) {
  const base = useId();
  const vars = doc.spec.variables ?? [];
  const targets = doc.spec.resources.flatMap((r) => {
    const schema = RESOURCE_SCHEMAS[r.type as ResourceType];
    if (!schema) return [];
    return Object.entries(schema.shape)
      .filter(([k, s]) => !SKIP.has(k) && ['number', 'boolean', 'string', 'enum'].includes(unwrap(s).kind))
      .map(([k]) => `${r.id}.${k}`);
  });
  const set = (i: number, patch: Partial<Var>, key: string) => {
    const next = structuredClone(doc);
    const v = { ...next.spec.variables![i]!, ...patch } as Record<string, unknown>;
    for (const [k, val] of Object.entries(patch)) if (val === undefined || (typeof val === 'number' && Number.isNaN(val))) delete v[k];
    next.spec.variables![i] = v as unknown as Var;
    commit(next, key);
  };
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">Variables</h3>
      <p className="text-[11px] text-fg-subtle">Knobs an operator can set per instance, each bound to one resource field.</p>
      <datalist id={`${base}-targets`}>
        {targets.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
      {vars.map((v, i) => (
        <fieldset key={i} className="space-y-2 rounded-md border border-border p-2.5">
          <legend className="px-1 font-mono text-xs">{v.name || `variable ${i + 1}`}</legend>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Name" htmlFor={`${base}-${i}-name`}>
              <TextInput id={`${base}-${i}-name`} className="font-mono" value={v.name} readOnly={readOnly} onChange={(s) => set(i, { name: s }, `var:${i}:name`)} />
            </Field>
            <Field label="Type" htmlFor={`${base}-${i}-type`}>
              <Select
                id={`${base}-${i}-type`}
                value={v.type}
                disabled={readOnly}
                onChange={(e) => {
                  const type = e.target.value as Var['type'];
                  set(i, { type, default: type === 'number' ? 1 : type === 'boolean' ? false : '' }, `var:${i}:type`);
                }}
              >
                <option value="number">number</option>
                <option value="string">string</option>
                <option value="boolean">boolean</option>
              </Select>
            </Field>
          </div>
          <Field label="Target" htmlFor={`${base}-${i}-target`} hint="resource.field">
            <Input id={`${base}-${i}-target`} list={`${base}-targets`} className="font-mono" value={v.target} readOnly={readOnly} onChange={(e) => set(i, { target: e.target.value }, `var:${i}:target`)} />
          </Field>
          {v.type === 'number' ? (
            <div className="grid grid-cols-3 gap-2">
              <Field label="Default" htmlFor={`${base}-${i}-def`}>
                <NumberInput id={`${base}-${i}-def`} value={typeof v.default === 'number' ? v.default : undefined} readOnly={readOnly} onChange={(n) => set(i, { default: n ?? 0 }, `var:${i}:default`)} step="any" />
              </Field>
              <Field label="Min" htmlFor={`${base}-${i}-min`}>
                <NumberInput id={`${base}-${i}-min`} value={v.min} readOnly={readOnly} onChange={(n) => set(i, { min: n }, `var:${i}:min`)} step="any" />
              </Field>
              <Field label="Max" htmlFor={`${base}-${i}-max`}>
                <NumberInput id={`${base}-${i}-max`} value={v.max} readOnly={readOnly} onChange={(n) => set(i, { max: n }, `var:${i}:max`)} step="any" />
              </Field>
            </div>
          ) : v.type === 'boolean' ? (
            <label className="flex items-center justify-between text-xs font-medium text-fg-muted">
              Default
              <input type="checkbox" checked={v.default === true} disabled={readOnly} onChange={(e) => set(i, { default: e.target.checked }, `var:${i}:default`)} />
            </label>
          ) : (
            <Field label="Default" htmlFor={`${base}-${i}-def`}>
              <TextInput id={`${base}-${i}-def`} value={String(v.default ?? '')} readOnly={readOnly} onChange={(s) => set(i, { default: s }, `var:${i}:default`)} />
            </Field>
          )}
          {!readOnly ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                const next = structuredClone(doc);
                next.spec.variables = vars.filter((_, j) => j !== i);
                commit(next);
              }}
            >
              <Trash2 size={13} aria-hidden /> Remove variable
            </Button>
          ) : null}
        </fieldset>
      ))}
      {!readOnly ? (
        <Button
          size="sm"
          onClick={() => {
            const next = structuredClone(doc);
            next.spec.variables = [...vars, { name: `var${vars.length + 1}`, type: 'number', default: 1, min: 1, max: 10, target: targets.find((t) => t.endsWith('.replicas')) ?? targets[0] ?? '' }];
            commit(next);
          }}
        >
          Add variable
        </Button>
      ) : null}
    </section>
  );
}

/** Two-way YAML: edits re-parse and update the canvas once they pass the schema. */
export function YamlPanel({ doc, commit, readOnly }: { doc: Draft; commit: Commit; readOnly: boolean }) {
  const [text, setText] = useState(() => yamlOf(doc));
  const [error, setError] = useState<string | null>(null);
  const editing = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!editing.current) setText(yamlOf(doc));
  }, [doc]);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const apply = (value: string) => {
    const parsed = parseTemplate(value);
    if (!parsed.ok) {
      const first = parsed.issues[0];
      setError(first ? `${first.path ? `${first.path}: ` : ''}${first.message}` : 'Invalid template.');
      return;
    }
    setError(null);
    commit(toDraft(parseYaml(value)), 'yaml');
  };

  return (
    <div className="flex h-full flex-col gap-2">
      <label htmlFor="builder-yaml" className="text-xs text-fg-subtle">
        The template document. Edits apply to the canvas as soon as they pass the schema.
      </label>
      <Textarea
        id="builder-yaml"
        value={text}
        readOnly={readOnly}
        spellCheck={false}
        aria-invalid={error ? true : undefined}
        className="min-h-[24rem] flex-1 font-mono text-[11.5px] leading-relaxed"
        onFocus={() => (editing.current = true)}
        onBlur={() => {
          editing.current = false;
          if (!error) setText(yamlOf(doc));
        }}
        onChange={(e) => {
          setText(e.target.value);
          if (timer.current) clearTimeout(timer.current);
          const v = e.target.value;
          timer.current = setTimeout(() => apply(v), 400);
        }}
      />
      {error ? (
        <p role="alert" className="text-xs text-danger-ink">
          Not applied — {error}
        </p>
      ) : null}
    </div>
  );
}

export function EdgeDialog({
  doc,
  pending,
  onClose,
  onAdd,
}: {
  doc: Draft;
  pending: { from: string; to: string } | null;
  onClose: () => void;
  onAdd: (kind: EdgeKind, data: { protocol?: string; port?: number; mode?: string; pathPrefix?: string }) => void;
}) {
  return (
    <Dialog open={!!pending} onClose={onClose} title="Connect resources" description={pending ? `${pending.from} → ${pending.to}` : undefined} size="sm">
      {pending ? <EdgeForm doc={doc} pending={pending} onClose={onClose} onAdd={onAdd} /> : null}
    </Dialog>
  );
}

function EdgeForm({ doc, pending, onClose, onAdd }: { doc: Draft; pending: { from: string; to: string }; onClose: () => void; onAdd: (kind: EdgeKind, data: { protocol?: string; port?: number; mode?: string; pathPrefix?: string }) => void }) {
  const kinds = edgeKindsFor(doc, pending.from, pending.to);
  const [kind, setKind] = useState<EdgeKind>(kinds[0]!);
  const [protocol, setProtocol] = useState(guessProtocol(doc, pending.to));
  const [port, setPort] = useState<number | undefined>(protocol === 'postgres' ? 5432 : protocol === 'redis' ? 6379 : undefined);
  const [mode, setMode] = useState('private-preferred');
  const [pathPrefix, setPathPrefix] = useState('/');
  const labels: Record<EdgeKind, { title: string; hint: string }> = {
    route: { title: 'Ingress route', hint: 'Traffic from the ingress is routed to this service.' },
    dns: { title: 'DNS target', hint: 'The DNS name points at this ingress.' },
    connectivity: { title: 'Network connection', hint: 'The source talks to the target over the network (protocol, port, privacy).' },
    dependsOn: { title: 'Dependency only', hint: 'Create the target first; no network rule.' },
  };
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        onAdd(kind, { protocol, port, mode, pathPrefix });
      }}
    >
      <fieldset className="space-y-1.5">
        <legend className="mb-1 text-xs font-medium text-fg-muted">Relationship</legend>
        {kinds.map((k) => (
          <label key={k} className={cn('flex cursor-pointer gap-2 rounded-md border p-2', kind === k ? 'border-accent' : 'border-border')}>
            <input type="radio" name="edge-kind" checked={kind === k} onChange={() => setKind(k)} className="mt-0.5" />
            <span>
              <span className="block text-sm font-medium">{labels[k].title}</span>
              <span className="block text-xs text-fg-subtle">{labels[k].hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {kind === 'connectivity' ? (
        <div className="grid grid-cols-2 gap-2">
          <Field label="Protocol" htmlFor="edge-proto">
            <Select id="edge-proto" value={protocol} onChange={(e) => setProtocol(e.target.value)}>
              {PROTOCOLS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Port" htmlFor="edge-port" hint="Optional">
            <NumberInput id="edge-port" value={port} min={1} max={65535} step={1} onChange={setPort} />
          </Field>
          <Field label="Mode" htmlFor="edge-mode" className="col-span-2">
            <Select id="edge-mode" value={mode} onChange={(e) => setMode(e.target.value)}>
              {MODES.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      ) : null}
      {kind === 'route' ? (
        <Field label="Path prefix" htmlFor="edge-path">
          <Input id="edge-path" value={pathPrefix} onChange={(e) => setPathPrefix(e.target.value)} />
        </Field>
      ) : null}
      <div className="flex justify-end gap-2 border-t border-border pt-3">
        <Button onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary">
          Connect
        </Button>
      </div>
    </form>
  );
}

