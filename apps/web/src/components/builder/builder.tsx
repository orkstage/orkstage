'use client';

import '@xyflow/react/dist/style.css';
import { cloneTemplateSchema, type PlanDto, type TemplateDto, type TemplateVersionDto } from '@co/contracts';
import type { Entitlements, PlanCode } from '@co/domain/core';
import { validateTemplate, type ValidationIssue, type ValidationReport } from '@co/templates';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import { AlertTriangle, CheckCircle2, Copy, Lock, Plus, Redo2, Save, Send, ShieldCheck, Undo2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { useForm } from 'react-hook-form';
import { parse as parseYaml } from 'yaml';
import { apiSend } from '@/lib/api';
import { usePlans } from '@/lib/queries';
import { useTheme } from '@/lib/theme';
import { cn } from '@/lib/utils';
import { RESOURCE_TYPE_META, ResourceIcon } from '../resource-icon';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Dialog } from '../ui/dialog';
import { ErrorNotice, Notice } from '../ui/error-notice';
import { describedBy, Field, Input } from '../ui/input';
import { Select } from '../ui/select';
import { TabPanel, Tabs } from '../ui/tabs';
import {
  addEdge,
  addLane,
  addResource,
  draftEdges,
  edit,
  emptyDraft,
  issueTarget,
  laneIsEmpty,
  nextVersion,
  placementOf,
  removeEdge,
  removeResource,
  RESOURCE_TYPES,
  toDraft,
  toggleEdgeKind,
  type Draft,
  type DraftEdge,
  type Res,
  type ResourceType,
} from './model';
import { EdgeDialog, EdgeInspector, LaneInspector, ResourceInspector, TemplatePanel, yamlOf, YamlPanel } from './panels';

/* ---------- geometry ---------- */
const NODE_W = 210;
const NODE_H = 66;
const LANE_HEADER = 40;
const LANE_GAP = 16;
const MIN_LANE_H = 170;
const COLS = 4;
const DRAG_TYPE = 'application/x-orkstage-resource';

type Pos = { dx: number; dy: number };
type Layout = Record<string, Pos>;
type Selection = { kind: 'resource'; id: string } | { kind: 'lane'; name: string } | { kind: 'edge'; id: string } | null;

interface LaneGeom {
  name: string;
  top: number;
  height: number;
  ids: string[];
  unknown?: boolean;
}

function computeGeometry(doc: Draft, layout: Layout) {
  const names = doc.spec.placements.map((p) => p.name);
  const groups = new Map<string, string[]>(names.map((n) => [n, []]));
  const orphans: string[] = [];
  for (const r of doc.spec.resources) {
    const p = placementOf(r);
    if (groups.has(p)) groups.get(p)!.push(r.id);
    else orphans.push(r.id);
  }
  const positions = new Map<string, { x: number; y: number }>();
  const lanes: LaneGeom[] = [];
  let top = 0;
  let width = 1000;
  const place = (name: string, ids: string[], unknown = false) => {
    let auto = 0;
    let maxBottom = 0;
    const local = new Map<string, Pos>();
    for (const id of ids) {
      let p = layout[id];
      if (!p) {
        const col = auto % COLS;
        const row = Math.floor(auto / COLS);
        auto++;
        p = { dx: 24 + col * (NODE_W + 36), dy: LANE_HEADER + 12 + row * (NODE_H + 26) };
      }
      const dy = Math.max(LANE_HEADER + 4, p.dy);
      local.set(id, { dx: Math.max(8, p.dx), dy });
      maxBottom = Math.max(maxBottom, dy + NODE_H);
      width = Math.max(width, p.dx + NODE_W + 40);
    }
    const height = Math.max(MIN_LANE_H, maxBottom + 24);
    for (const [id, p] of local) positions.set(id, { x: p.dx, y: top + p.dy });
    lanes.push({ name, top, height, ids, unknown });
    top += height + LANE_GAP;
  };
  for (const n of names) place(n, groups.get(n)!);
  if (orphans.length) place('__unknown__', orphans, true);
  return { lanes, positions, width };
}

/* ---------- history ---------- */
interface History {
  past: Draft[];
  present: Draft;
  future: Draft[];
  key?: string;
  at: number;
}

function useHistory(initial: Draft) {
  const [h, setH] = useState<History>({ past: [], present: initial, future: [], at: 0 });
  const commit = useCallback((next: Draft, key?: string) => {
    setH((prev) => {
      const now = Date.now();
      // Consecutive edits to the same field within a moment collapse into one undo step.
      if (key && prev.key === key && now - prev.at < 1500) return { ...prev, present: next, future: [], at: now };
      return { past: [...prev.past, prev.present].slice(-100), present: next, future: [], key, at: now };
    });
  }, []);
  const undo = useCallback(() => setH((p) => (p.past.length ? { past: p.past.slice(0, -1), present: p.past[p.past.length - 1]!, future: [p.present, ...p.future], at: 0 } : p)), []);
  const redo = useCallback(() => setH((p) => (p.future.length ? { past: [...p.past, p.present], present: p.future[0]!, future: p.future.slice(1), at: 0 } : p)), []);
  return { doc: h.present, commit, undo, redo, canUndo: h.past.length > 0, canRedo: h.future.length > 0 };
}

/* ---------- layout persistence (browser only, per template + version) ---------- */
const layoutKey = (templateId: string | undefined, versionId: string | undefined) => `orkstage-builder-layout:${templateId ?? 'new'}:${versionId ?? 'draft'}`;
function loadLayout(key: string): Layout {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as Layout) : {};
  } catch {
    return {};
  }
}
function saveLayout(key: string, layout: Layout) {
  try {
    localStorage.setItem(key, JSON.stringify(layout));
  } catch {
    /* quota or private mode: layout is cosmetic */
  }
}

/* ---------- nodes ---------- */
type LaneData = { name: string; description?: string; providers: string[]; count: number; selected: boolean; errors: number; unknown?: boolean; width: number; height: number };
type ResData = { res: Res; selected: boolean; errors: number; warnings: number };

const LaneNode = memo(function LaneNode({ data }: NodeProps<Node<LaneData, 'lane'>>) {
  return (
    <div
      className={cn('h-full w-full rounded-lg border', data.unknown ? 'border-dashed border-danger/60 bg-danger/5' : 'border-border bg-surface/50', data.selected && 'border-accent ring-1 ring-accent')}
      style={{ width: data.width, height: data.height }}
    >
      <div className="flex h-9 items-center gap-2 border-b border-border/60 px-3">
        <span className="font-mono text-xs font-semibold text-fg">{data.unknown ? 'unknown placement' : data.name}</span>
        {data.description ? <span className="truncate text-[11px] text-fg-subtle">{data.description}</span> : null}
        <span className="ml-auto flex gap-1">
          {data.providers.length === 0 ? (
            <span className="rounded-full border border-border px-1.5 text-[10px] text-fg-subtle">any provider</span>
          ) : (
            data.providers.map((p) => (
              <span key={p} className="rounded-full border border-border px-1.5 font-mono text-[10px] text-fg-muted">
                {p}
              </span>
            ))
          )}
          {data.errors ? <span className="rounded-full bg-danger/12 px-1.5 text-[10px] font-medium text-danger-ink">{data.errors}</span> : null}
        </span>
      </div>
    </div>
  );
});

const ResNode = memo(function ResNode({ data }: NodeProps<Node<ResData, 'res'>>) {
  const r = data.res;
  const meta = RESOURCE_TYPE_META[r.type];
  const disabled = r.enabled === false;
  return (
    <div
      className={cn(
        'relative flex items-center gap-2.5 rounded-md border bg-surface px-2.5 shadow-card',
        data.selected ? 'border-accent ring-1 ring-accent' : data.errors ? 'border-danger/60' : data.warnings ? 'border-warn/60' : 'border-border-strong',
        disabled && 'opacity-60',
      )}
      style={{ width: NODE_W, height: NODE_H }}
    >
      <Handle type="target" position={Position.Left} className="!h-2.5 !w-2.5" />
      <ResourceIcon type={r.type} size={24} />
      <div className="min-w-0 flex-1">
        <p className="truncate font-mono text-xs font-semibold text-fg">{r.id}</p>
        <p className="truncate text-[11px] text-fg-subtle">
          {meta?.label ?? r.type}
          {disabled ? ' · disabled' : ''}
        </p>
      </div>
      {data.errors || data.warnings ? (
        <span
          className={cn('absolute -right-2 -top-2 flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[10px] font-semibold', data.errors ? 'bg-danger text-danger-fg' : 'bg-warn text-accent-fg')}
          title={`${data.errors} error(s), ${data.warnings} warning(s)`}
        >
          {data.errors || data.warnings}
        </span>
      ) : null}
      <Handle type="source" position={Position.Right} className="!h-2.5 !w-2.5" />
    </div>
  );
});

const nodeTypes = { lane: LaneNode, res: ResNode };

/* ---------- component ---------- */
export interface TemplateBuilderProps {
  template: TemplateDto | null;
  baseVersion: TemplateVersionDto | null;
  /** YAML source of the base version (null for a new template). Parsed here, not in the page, so yaml stays in this lazy chunk. */
  initialSource: string | null;
  readOnly: boolean;
  readOnlyReason?: string;
  canClone: boolean;
  canPublish: boolean;
}

export default function TemplateBuilder(props: TemplateBuilderProps) {
  return (
    <ReactFlowProvider>
      <BuilderInner {...props} />
    </ReactFlowProvider>
  );
}

function BuilderInner({ template, baseVersion, initialSource, readOnly, readOnlyReason, canClone, canPublish }: TemplateBuilderProps) {
  const router = useRouter();
  const qc = useQueryClient();
  const theme = useTheme();
  const flow = useReactFlow();
  const plans = usePlans();
  const isNew = !template;

  const [initialDoc] = useState<Draft>(() => {
    if (!initialSource) return emptyDraft();
    try {
      return toDraft(parseYaml(initialSource));
    } catch {
      return toDraft(baseVersion?.document ?? {});
    }
  });
  const { doc, commit, undo, redo, canUndo, canRedo } = useHistory(initialDoc);
  const [lkey, setLkey] = useState(() => layoutKey(template?.id, baseVersion?.id));
  const [layout, setLayout] = useState<Layout>({});
  useEffect(() => setLayout(loadLayout(lkey)), [lkey]);
  const updateLayout = useCallback(
    (fn: (l: Layout) => Layout) =>
      setLayout((prev) => {
        const next = fn(prev);
        saveLayout(lkey, next);
        return next;
      }),
    [lkey],
  );

  const [selection, setSelection] = useState<Selection>(null);
  const [tab, setTab] = useState<'inspector' | 'template' | 'yaml'>('inspector');
  const [pendingEdge, setPendingEdge] = useState<{ from: string; to: string } | null>(null);
  const [planCode, setPlanCode] = useState('');
  const [report, setReport] = useState<ValidationReport>({ valid: true, issues: [] });
  const [saved, setSaved] = useState<{ version: TemplateVersionDto; json: string } | null>(null);
  const [cloning, setCloning] = useState(false);
  const initialJson = useRef(JSON.stringify(initialDoc));
  const docJson = useMemo(() => JSON.stringify(doc), [doc]);
  const dirty = docJson !== (saved?.json ?? initialJson.current);

  /* live validation (debounced) */
  useEffect(() => {
    const t = setTimeout(() => {
      const plan = plans.data?.find((p) => p.code === planCode);
      setReport(validateTemplate(doc, plan ? { code: plan.code as PlanCode, entitlements: plan.entitlements as unknown as Entitlements } : undefined));
    }, 250);
    return () => clearTimeout(t);
  }, [doc, planCode, plans.data]);

  const issuesBy = useMemo(() => {
    const res = new Map<string, ValidationIssue[]>();
    const lanes = new Map<string, ValidationIssue[]>();
    for (const i of report.issues) {
      const t = issueTarget(i, doc);
      if (t.kind === 'resource') res.set(t.id, [...(res.get(t.id) ?? []), i]);
      if (t.kind === 'lane') lanes.set(t.name, [...(lanes.get(t.name) ?? []), i]);
    }
    return { res, lanes };
  }, [report, doc]);

  /* nodes & edges */
  const geom = useMemo(() => computeGeometry(doc, layout), [doc, layout]);
  const built = useMemo<Node[]>(() => {
    const lanes: Node[] = geom.lanes.map((l) => {
      const slot = doc.spec.placements.find((p) => p.name === l.name);
      return {
        id: `lane:${l.name}`,
        type: 'lane',
        position: { x: 0, y: l.top },
        draggable: false,
        connectable: false,
        zIndex: 0,
        style: { width: geom.width, height: l.height },
        data: {
          name: l.name,
          description: slot?.description,
          providers: slot?.providers ?? [],
          count: l.ids.length,
          selected: selection?.kind === 'lane' && selection.name === l.name,
          errors: issuesBy.lanes.get(l.name)?.filter((i) => i.severity === 'error').length ?? 0,
          unknown: l.unknown,
          width: geom.width,
          height: l.height,
        } satisfies LaneData,
      };
    });
    const res: Node[] = doc.spec.resources.map((r) => {
      const iss = issuesBy.res.get(r.id) ?? [];
      return {
        id: `res:${r.id}`,
        type: 'res',
        position: geom.positions.get(r.id) ?? { x: 0, y: 0 },
        draggable: !readOnly,
        connectable: !readOnly,
        zIndex: 1,
        data: { res: r, selected: selection?.kind === 'resource' && selection.id === r.id, errors: iss.filter((i) => i.severity === 'error').length, warnings: iss.filter((i) => i.severity === 'warning').length } satisfies ResData,
      };
    });
    return [...lanes, ...res];
  }, [geom, doc, selection, issuesBy, readOnly]);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(built);
  useEffect(() => setNodes(built), [built, setNodes]);

  const dEdges = useMemo(() => draftEdges(doc), [doc]);
  const edges = useMemo<Edge[]>(
    () =>
      dEdges.map((e) => {
        const selected = selection?.kind === 'edge' && selection.id === e.id;
        const color = selected ? 'var(--accent)' : e.kind === 'connectivity' ? 'var(--fg-subtle)' : e.kind === 'dependsOn' ? 'var(--border-strong)' : 'var(--info)';
        return {
          id: e.id,
          source: `res:${e.from}`,
          target: `res:${e.to}`,
          label: e.kind === 'dependsOn' ? undefined : e.label,
          zIndex: 2,
          interactionWidth: 18,
          style: { stroke: color, strokeWidth: selected ? 2 : e.kind === 'dependsOn' ? 1 : 1.5, strokeDasharray: e.kind === 'dependsOn' || e.kind === 'dns' ? '5 4' : undefined },
          markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color },
          labelBgPadding: [4, 2] as [number, number],
        };
      }),
    [dEdges, selection],
  );

  /* actions */
  const laneAtY = useCallback(
    (y: number) => {
      const real = geom.lanes.filter((l) => !l.unknown);
      return real.find((l) => y >= l.top && y < l.top + l.height + LANE_GAP) ?? (y < 0 ? real[0] : real[real.length - 1]);
    },
    [geom],
  );

  const add = useCallback(
    (type: ResourceType, at?: { x: number; y: number }) => {
      if (readOnly) return;
      const lane =
        at !== undefined
          ? laneAtY(at.y)
          : geom.lanes.find((l) => !l.unknown && ((selection?.kind === 'lane' && l.name === selection.name) || (selection?.kind === 'resource' && l.ids.includes(selection.id)))) ??
            geom.lanes.find((l) => !l.unknown);
      const placement = lane?.name ?? doc.spec.placements[0]?.name ?? 'primary';
      const { doc: next, id } = addResource(doc, type, placement);
      commit(next);
      if (at && lane) updateLayout((l) => ({ ...l, [id]: { dx: Math.max(8, at.x - NODE_W / 2), dy: Math.max(LANE_HEADER + 4, at.y - lane.top - NODE_H / 2) } }));
      setSelection({ kind: 'resource', id });
      setTab('inspector');
    },
    [readOnly, laneAtY, geom, selection, doc, commit, updateLayout],
  );

  const deleteSelection = useCallback(() => {
    if (readOnly || !selection) return;
    if (selection.kind === 'resource') {
      commit(removeResource(doc, selection.id));
      updateLayout((l) => {
        const { [selection.id]: _drop, ...rest } = l;
        return rest;
      });
    } else if (selection.kind === 'edge') {
      const e = dEdges.find((x) => x.id === selection.id);
      if (e) commit(removeEdge(doc, e));
    } else if (selection.kind === 'lane') {
      if (doc.spec.placements.length > 1 && laneIsEmpty(doc, selection.name)) commit(edit(doc, (d) => (d.spec.placements = d.spec.placements.filter((p) => p.name !== selection.name))));
      else return;
    }
    setSelection(null);
  }, [readOnly, selection, doc, dEdges, commit, updateLayout]);

  /* keyboard: Delete removes the selection; Ctrl+Z / Ctrl+Y (or Ctrl+Shift+Z) undo/redo */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.closest('input, textarea, select, [contenteditable="true"]') || t.closest('dialog'))) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        if (!readOnly) undo();
      } else if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
        e.preventDefault();
        if (!readOnly) redo();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selection) {
          e.preventDefault();
          deleteSelection();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, deleteSelection, selection, readOnly]);

  /* warn before leaving with unsaved edits */
  useEffect(() => {
    if (!dirty || readOnly) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty, readOnly]);

  const onDragStop = useCallback(
    (_: unknown, node: Node) => {
      if (!node.id.startsWith('res:') || readOnly) return;
      const id = node.id.slice(4);
      const lane = laneAtY(node.position.y + NODE_H / 2);
      if (!lane) return;
      const res = doc.spec.resources.find((r) => r.id === id);
      updateLayout((l) => ({ ...l, [id]: { dx: Math.max(8, node.position.x), dy: Math.max(LANE_HEADER + 4, node.position.y - lane.top) } }));
      if (res && placementOf(res) !== lane.name) {
        commit(edit(doc, (d) => (d.spec.resources.find((r) => r.id === id)!.placement = lane.name)));
      }
    },
    [readOnly, laneAtY, doc, commit, updateLayout],
  );

  const onDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      const type = e.dataTransfer.getData(DRAG_TYPE) as ResourceType;
      if (!type || !RESOURCE_TYPES.includes(type)) return;
      e.preventDefault();
      add(type, flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }));
    },
    [add, flow],
  );

  const select = (s: Selection) => {
    setSelection(s);
    setTab('inspector');
  };

  const focusIssue = (issue: ValidationIssue) => {
    const t = issueTarget(issue, doc);
    if (t.kind === 'resource') {
      select({ kind: 'resource', id: t.id });
      void flow.fitView({ nodes: [{ id: `res:${t.id}` }], duration: 250, maxZoom: 1.2 });
    } else if (t.kind === 'lane') select({ kind: 'lane', name: t.name });
    else setTab('template');
  };

  /* server actions (existing endpoints only) */
  const source = useMemo(() => yamlOf(doc), [doc]);
  const serverValidate = useMutation({
    mutationFn: () => apiSend<ValidationReport>('POST', `/templates/${template!.id}/validate`, { source, ...(planCode ? { planCode } : {}) }),
  });
  const save = useMutation({
    mutationFn: async () => {
      if (isNew) return { kind: 'created' as const, template: await apiSend<TemplateDto>('POST', '/templates', { source }) };
      const version = nextVersion(doc.metadata.version, (template!.versions ?? []).map((v) => v.version));
      let d = doc;
      if (version !== doc.metadata.version) {
        d = edit(doc, (x) => (x.metadata.version = version));
        commit(d);
      }
      const v = await apiSend<TemplateVersionDto>('POST', `/templates/${template!.id}/versions`, { source: yamlOf(d) });
      return { kind: 'version' as const, version: v, json: JSON.stringify(d) };
    },
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ['templates'] });
      if (res.kind === 'created') {
        saveLayout(layoutKey(res.template.id, res.template.versions?.[0]?.id ?? res.template.latestPublished?.id), layout);
        router.replace(`/templates/${res.template.id}/builder`);
        return;
      }
      void qc.invalidateQueries({ queryKey: ['template', template!.id] });
      const key = layoutKey(template!.id, res.version.id);
      saveLayout(key, layout);
      setLkey(key);
      setSaved({ version: res.version, json: res.json });
    },
  });
  const publish = useMutation({
    mutationFn: (versionId: string) => apiSend<TemplateVersionDto>('POST', `/templates/${template!.id}/versions/${versionId}/publish`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['template', template!.id] });
      void qc.invalidateQueries({ queryKey: ['templates'] });
    },
  });

  const errors = report.issues.filter((i) => i.severity === 'error');
  const warnings = report.issues.filter((i) => i.severity === 'warning');
  const selectedRes = selection?.kind === 'resource' ? doc.spec.resources.find((r) => r.id === selection.id) : undefined;
  const selectedEdge = selection?.kind === 'edge' ? dEdges.find((e) => e.id === selection.id) : undefined;
  const canPublishSaved = !!saved && !dirty && canPublish && !publish.isSuccess;

  return (
    <div className="flex flex-col gap-3">
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="mr-auto min-w-0">
          <p className="text-xs text-fg-subtle">
            <Link href={template ? `/templates/${template.id}` : '/templates'} className="hover:underline">
              {template ? template.displayName : 'Templates'}
            </Link>{' '}
            / builder
          </p>
          <h1 className="flex flex-wrap items-center gap-2 font-display text-lg font-semibold">
            {doc.metadata.displayName || doc.metadata.name || 'Untitled template'}
            <Badge>
              <span className="font-mono">v{doc.metadata.version}</span>
            </Badge>
            {readOnly ? (
              <Badge tone="info">
                <Lock size={10} aria-hidden /> read-only
              </Badge>
            ) : dirty ? (
              <Badge tone="warn">unsaved</Badge>
            ) : null}
            {errors.length ? (
              <Badge tone="danger">
                {errors.length} error{errors.length === 1 ? '' : 's'}
              </Badge>
            ) : (
              <Badge tone="ok">
                <CheckCircle2 size={10} aria-hidden /> valid
              </Badge>
            )}
          </h1>
        </div>
        <Button size="sm" variant="ghost" onClick={undo} disabled={!canUndo || readOnly} aria-label="Undo (Ctrl+Z)" title="Undo (Ctrl+Z)">
          <Undo2 size={14} />
        </Button>
        <Button size="sm" variant="ghost" onClick={redo} disabled={!canRedo || readOnly} aria-label="Redo (Ctrl+Y)" title="Redo (Ctrl+Y)">
          <Redo2 size={14} />
        </Button>
        <Button
          size="sm"
          disabled={readOnly}
          onClick={() => {
            const { doc: next, name } = addLane(doc);
            commit(next);
            select({ kind: 'lane', name });
          }}
        >
          <Plus size={13} aria-hidden /> Add slot
        </Button>
        <label className="sr-only" htmlFor="builder-plan">
          Validate against plan
        </label>
        <Select id="builder-plan" value={planCode} onChange={(e) => setPlanCode(e.target.value)} className="h-7 w-40 text-xs">
          <option value="">Any plan</option>
          {(plans.data ?? []).map((p: PlanDto) => (
            <option key={p.code} value={p.code}>
              Check vs {p.name}
            </option>
          ))}
        </Select>
        {!isNew ? (
          <Button size="sm" onClick={() => serverValidate.mutate()} loading={serverValidate.isPending}>
            <ShieldCheck size={13} aria-hidden /> Validate on server
          </Button>
        ) : null}
        {readOnly ? (
          canClone && template ? (
            <Button size="sm" variant="primary" onClick={() => setCloning(true)}>
              <Copy size={13} aria-hidden /> Clone to edit
            </Button>
          ) : null
        ) : (
          <>
            <Button size="sm" variant="primary" onClick={() => save.mutate()} loading={save.isPending} disabled={!dirty && !isNew}>
              <Save size={13} aria-hidden /> {isNew ? 'Create template' : 'Save draft'}
            </Button>
            {!isNew ? (
              <Button size="sm" onClick={() => saved && publish.mutate(saved.version.id)} loading={publish.isPending} disabled={!canPublishSaved} title={canPublishSaved ? undefined : 'Save a draft first; publishing applies to the saved version'}>
                <Send size={13} aria-hidden /> Publish
              </Button>
            ) : null}
          </>
        )}
      </div>

      {readOnly && readOnlyReason ? (
        <Notice tone="info">
          <span className="flex items-start gap-2">
            <Lock size={14} className="mt-0.5 shrink-0" aria-hidden /> {readOnlyReason}
          </span>
        </Notice>
      ) : null}
      {save.error ? <ErrorNotice error={save.error} title="Not saved" /> : null}
      {publish.error ? <ErrorNotice error={publish.error} title="Publish refused" /> : null}
      {saved && !publish.isSuccess ? (
        <Notice tone="ok">
          Saved as draft <strong className="font-mono">{saved.version.version}</strong>. {canPublish ? 'Publish it when you are ready; published versions never change.' : ''}
        </Notice>
      ) : null}
      {publish.isSuccess ? <Notice tone="ok">Published. New instances can now use version {saved?.version.version}.</Notice> : null}

      <div className="grid gap-3 lg:grid-cols-[12.5rem_minmax(0,1fr)_22rem]">
        {/* palette */}
        <aside aria-label="Resource palette" className="space-y-1.5">
          <p className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">Resources</p>
          <p className="text-[11px] text-fg-subtle">{readOnly ? 'Read-only.' : 'Drag onto a lane, or use Add.'}</p>
          <ul className="grid grid-cols-2 gap-1.5 lg:grid-cols-1">
            {RESOURCE_TYPES.map((type) => {
              const meta = RESOURCE_TYPE_META[type]!;
              return (
                <li
                  key={type}
                  draggable={!readOnly}
                  onDragStart={(e) => {
                    e.dataTransfer.setData(DRAG_TYPE, type);
                    e.dataTransfer.effectAllowed = 'copy';
                  }}
                  className={cn('flex items-center gap-2 rounded-md border border-border bg-surface px-2 py-1.5', !readOnly && 'cursor-grab active:cursor-grabbing hover:border-border-strong')}
                  aria-label={`${meta.label}${readOnly ? '' : ', draggable'}`}
                >
                  <ResourceIcon type={type} size={18} />
                  <span className="min-w-0 flex-1 truncate text-xs">{meta.label}</span>
                  <button
                    type="button"
                    disabled={readOnly}
                    onClick={() => add(type)}
                    className="rounded p-0.5 text-fg-subtle hover:bg-surface-2 hover:text-fg disabled:opacity-40"
                    aria-label={`Add ${meta.label}`}
                    title={`Add ${meta.label}`}
                  >
                    <Plus size={14} />
                  </button>
                </li>
              );
            })}
          </ul>
        </aside>

        {/* canvas */}
        <div
          className="bg-grid h-[620px] overflow-hidden rounded-md border border-border"
          onDragOver={(e) => {
            if (readOnly) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
          }}
          onDrop={onDrop}
          aria-label="Template canvas. Placement slots are lanes; resources are nodes; drag between handles to connect."
        >
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            colorMode={theme}
            onNodesChange={onNodesChange}
            onNodeDragStop={onDragStop}
            onNodeClick={(_, n) => (n.id.startsWith('res:') ? select({ kind: 'resource', id: n.id.slice(4) }) : n.id !== 'lane:__unknown__' ? select({ kind: 'lane', name: n.id.slice(5) }) : null)}
            onEdgeClick={(_, e) => select({ kind: 'edge', id: e.id })}
            onPaneClick={() => setSelection(null)}
            onConnect={(c: Connection) => {
              if (readOnly || !c.source || !c.target || c.source === c.target) return;
              setPendingEdge({ from: c.source.slice(4), to: c.target.slice(4) });
            }}
            nodesConnectable={!readOnly}
            deleteKeyCode={null}
            fitView
            fitViewOptions={{ padding: 0.08 }}
            minZoom={0.25}
            maxZoom={1.6}
          >
            <Background gap={32} size={1} color="var(--border)" />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>

        {/* inspector */}
        <aside aria-label="Inspector" className="min-w-0 rounded-md border border-border bg-surface">
          <Tabs
            idPrefix="builder"
            label="Builder panels"
            value={tab}
            onChange={setTab}
            className="px-2"
            tabs={[
              { id: 'inspector', label: 'Inspector' },
              { id: 'template', label: 'Template' },
              { id: 'yaml', label: 'YAML' },
            ]}
          />
          <div className="max-h-[580px] overflow-y-auto px-3 pb-3">
            {tab === 'inspector' ? (
              <TabPanel id="inspector" idPrefix="builder" className="pt-3">
                {selectedRes ? (
                  <ResourceInspector key={selectedRes.id} doc={doc} res={selectedRes} commit={commit} readOnly={readOnly} issues={issuesBy.res.get(selectedRes.id) ?? []} onDelete={deleteSelection} />
                ) : selection?.kind === 'lane' ? (
                  <LaneInspector key={selection.name} doc={doc} name={selection.name} commit={commit} readOnly={readOnly} issues={issuesBy.lanes.get(selection.name) ?? []} onDelete={deleteSelection} />
                ) : selectedEdge ? (
                  <EdgeInspector key={selectedEdge.id} doc={doc} edge={selectedEdge} commit={commit} readOnly={readOnly} onDelete={deleteSelection} onToggleKind={() => commit(toggleEdgeKind(doc, selectedEdge as DraftEdge))} />
                ) : (
                  <div className="space-y-2 text-xs text-fg-subtle">
                    <p className="text-sm text-fg">Select something on the canvas.</p>
                    <ul className="list-disc space-y-1 pl-4">
                      <li>Lanes are placement slots: each instance binds a slot to a cloud account and region.</li>
                      <li>Drag a resource into a lane to place it there.</li>
                      <li>Drag from a node’s right handle to another node to add a connection, dependency, ingress route or DNS target.</li>
                      <li>Delete removes the selection; Ctrl+Z / Ctrl+Y undo and redo.</li>
                    </ul>
                  </div>
                )}
              </TabPanel>
            ) : null}
            {tab === 'template' ? (
              <TabPanel id="template" idPrefix="builder" className="pt-3">
                <TemplatePanel doc={doc} commit={commit} readOnly={readOnly} />
              </TabPanel>
            ) : null}
            {tab === 'yaml' ? (
              <TabPanel id="yaml" idPrefix="builder" className="pt-3">
                <YamlPanel doc={doc} commit={commit} readOnly={readOnly} />
              </TabPanel>
            ) : null}
          </div>
        </aside>
      </div>

      {/* problems */}
      <section aria-labelledby="problems-heading" className="rounded-md border border-border bg-surface">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <h2 id="problems-heading" className="text-sm font-semibold">
            Problems
          </h2>
          <Badge tone={errors.length ? 'danger' : 'neutral'}>{errors.length} errors</Badge>
          <Badge tone={warnings.length ? 'warn' : 'neutral'}>{warnings.length} warnings</Badge>
          <span className="ml-auto text-[11px] text-fg-subtle">Checked as you edit{planCode ? ` against the ${planCode} plan` : ''}.</span>
        </div>
        {report.issues.length === 0 ? (
          <p className="flex items-center gap-1.5 px-3 py-2 text-sm text-ok-ink">
            <CheckCircle2 size={14} aria-hidden /> No problems in the template.
          </p>
        ) : (
          <ul className="max-h-48 divide-y divide-border overflow-y-auto">
            {report.issues.map((i, n) => (
              <li key={n}>
                <button type="button" onClick={() => focusIssue(i)} className="flex w-full items-start gap-2 px-3 py-1.5 text-left text-sm hover:bg-surface-2">
                  <AlertTriangle size={14} className={cn('mt-0.5 shrink-0', i.severity === 'error' ? 'text-danger-ink' : 'text-warn-ink')} aria-label={i.severity} />
                  <span className="min-w-0 flex-1">
                    {i.message}
                    {i.path ? <code className="ml-2 font-mono text-[11px] text-fg-subtle">{i.path}</code> : null}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-fg-subtle">{i.code}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {serverValidate.error ? <ErrorNotice error={serverValidate.error} className="m-3" /> : null}
        {serverValidate.data ? (
          <div className="border-t border-border px-3 py-2 text-sm">
            <p className="mb-1 font-medium">
              Server validation: {serverValidate.data.valid ? <span className="text-ok-ink">passed</span> : <span className="text-danger-ink">failed</span>}
              <span className="ml-2 text-[11px] font-normal text-fg-subtle">Includes capability and policy checks the browser cannot run.</span>
            </p>
            <ul className="space-y-0.5 text-xs">
              {(serverValidate.data.issues ?? []).map((i, n) => (
                <li key={n}>
                  <button type="button" onClick={() => focusIssue(i)} className="text-left hover:underline">
                    <span className={i.severity === 'error' ? 'text-danger-ink' : 'text-warn-ink'}>{i.severity}</span> {i.message}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <EdgeDialog
        doc={doc}
        pending={pendingEdge}
        onClose={() => setPendingEdge(null)}
        onAdd={(kind, data) => {
          if (pendingEdge) commit(addEdge(doc, kind, pendingEdge.from, pendingEdge.to, data));
          setPendingEdge(null);
        }}
      />
      {template ? (
        <Dialog open={cloning} onClose={() => setCloning(false)} title={`Clone ${template.displayName}`} description="Creates an editable organization copy and opens it in the builder.">
          <CloneForm template={template} onDone={() => setCloning(false)} />
        </Dialog>
      ) : null}
    </div>
  );
}

function CloneForm({ template, onDone }: { template: TemplateDto; onDone: () => void }) {
  const router = useRouter();
  const qc = useQueryClient();
  const form = useForm({
    resolver: zodResolver(cloneTemplateSchema),
    defaultValues: { name: `${template.name}-copy`.slice(0, 63), displayName: `${template.displayName} (copy)`.slice(0, 80) },
  });
  const { errors } = form.formState;
  const clone = useMutation({
    mutationFn: (v: { name: string; displayName: string }) => apiSend<TemplateDto>('POST', `/templates/${template.id}/clone`, v),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ['templates'] });
      onDone();
      router.push(`/templates/${res.id}/builder`);
    },
  });
  return (
    <form onSubmit={form.handleSubmit((v) => clone.mutate(v))} className="space-y-4" noValidate>
      <Field label="Name" htmlFor="bclone-name" hint="Lowercase identifier, unique in your organization." error={errors.name?.message} required>
        <Input id="bclone-name" className="font-mono" autoFocus {...describedBy('bclone-name', { hint: true, error: errors.name })} {...form.register('name')} />
      </Field>
      <Field label="Display name" htmlFor="bclone-display" error={errors.displayName?.message} required>
        <Input id="bclone-display" {...describedBy('bclone-display', { error: errors.displayName })} {...form.register('displayName')} />
      </Field>
      {clone.error ? <ErrorNotice error={clone.error} /> : null}
      <div className="flex justify-end gap-2 border-t border-border pt-3">
        <Button onClick={onDone}>Cancel</Button>
        <Button type="submit" variant="primary" loading={clone.isPending}>
          Clone and open
        </Button>
      </div>
    </form>
  );
}
