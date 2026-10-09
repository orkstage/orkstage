'use client';

import '@xyflow/react/dist/style.css';
import type { PreviewDto, ResourceDto } from '@co/contracts';
import { Graph, layout } from '@dagrejs/dagre';
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react';
import { memo, useMemo } from 'react';
import { useTranslations } from 'use-intl';
import { useTheme } from '@/lib/theme';
import { topologyEdges } from '@/lib/topology-graph';
import { cn, shortId } from '@/lib/utils';
import { ProviderLogo, ResourceIcon } from '../resource-icon';
import { StatusDot } from '../ui/status-badge';

const NODE_W = 220;
const NODE_H = 64;
const PAD = 14;
const HEADER = 28;
const GAP = 18;

type ZoneData = { label: string; level: 'provider' | 'target' | 'region'; provider?: string; simulated?: boolean };
type ResourceData = { r: ResourceDto };
type ZoneNode = Node<ZoneData, 'zone'>;
type ResNode = Node<ResourceData, 'resource'>;

interface Box {
  w: number;
  h: number;
}

/** Lays out one region's resources with dagre (dependents on the left, dependencies on the right). */
function layoutRegion(list: ResourceDto[], edges: { from: string; to: string }[]) {
  const g = new Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 16, ranksep: 40, marginx: 0, marginy: 0 });
  g.setDefaultEdgeLabel(() => ({}));
  const ids = new Set(list.map((r) => r.resourceId));
  for (const r of list) g.setNode(r.resourceId, { width: NODE_W, height: NODE_H });
  for (const e of edges) if (ids.has(e.from) && ids.has(e.to)) g.setEdge(e.from, e.to);
  layout(g);
  let maxX = 0;
  let maxY = 0;
  const pos = new Map<string, { x: number; y: number }>();
  for (const r of list) {
    const n = g.node(r.resourceId) as { x: number; y: number };
    const x = n.x - NODE_W / 2;
    const y = n.y - NODE_H / 2;
    pos.set(r.resourceId, { x, y });
    maxX = Math.max(maxX, x + NODE_W);
    maxY = Math.max(maxY, y + NODE_H);
  }
  return { pos, w: maxX, h: maxY };
}

function buildGraph(resources: ResourceDto[], edges: ReturnType<typeof topologyEdges>, targetNames: Map<string, string>, targetFallback: (id: string) => string) {
  // provider key → targetId → region → resources
  const tree = new Map<string, Map<string, Map<string, ResourceDto[]>>>();
  for (const r of resources) {
    const pk = r.simulatedProvider ? `sim:${r.simulatedProvider}` : r.provider;
    const t = tree.get(pk) ?? new Map<string, Map<string, ResourceDto[]>>();
    const g = t.get(r.targetId) ?? new Map<string, ResourceDto[]>();
    g.set(r.region, [...(g.get(r.region) ?? []), r]);
    t.set(r.targetId, g);
    tree.set(pk, t);
  }

  // Dependents first (left), so arrows flow left → right across providers too.
  const depth = new Map<string, number>();
  const out = new Map<string, string[]>();
  for (const e of edges) out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
  const visit = (id: string, seen = new Set<string>()): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (seen.has(id)) return 0;
    seen.add(id);
    const d = 1 + Math.max(0, ...(out.get(id) ?? []).map((n) => visit(n, seen)));
    depth.set(id, d);
    return d;
  };
  const providerRank = (pk: string) => {
    const ids = [...tree.get(pk)!.values()].flatMap((g) => [...g.values()].flat()).map((r) => r.resourceId);
    return -Math.max(...ids.map((id) => visit(id)));
  };
  const providers = [...tree.keys()].sort((a, b) => providerRank(a) - providerRank(b));

  const zones: ZoneNode[] = [];
  const nodes: ResNode[] = [];
  let px = 0;
  for (const pk of providers) {
    const simulated = pk.startsWith('sim:');
    const provider = simulated ? pk.slice(4) : pk;
    const providerId = `p:${pk}`;
    const targets = tree.get(pk)!;
    const providerChildren: { zone: ZoneNode; children: (ZoneNode | ResNode)[] }[] = [];
    let ty = HEADER;
    let pw = 0;
    for (const [targetId, regions] of targets) {
      const targetNodeId = `${providerId}/t:${targetId}`;
      let ry = HEADER;
      let tw = 0;
      const targetChildren: (ZoneNode | ResNode)[] = [];
      for (const [region, list] of regions) {
        const regionId = `${targetNodeId}/r:${region}`;
        const l = layoutRegion(list, edges);
        const box: Box = { w: l.w + PAD * 2, h: l.h + PAD + HEADER };
        targetChildren.push({
          id: regionId,
          type: 'zone',
          parentId: targetNodeId,
          position: { x: PAD, y: ry },
          data: { label: region, level: 'region' },
          style: { width: box.w, height: box.h },
          draggable: false,
          selectable: false,
        });
        for (const r of list) {
          const p = l.pos.get(r.resourceId)!;
          targetChildren.push({ id: r.resourceId, type: 'resource', parentId: regionId, position: { x: PAD + p.x, y: HEADER + p.y }, data: { r }, draggable: false });
        }
        ry += box.h + GAP;
        tw = Math.max(tw, box.w);
      }
      const tBox: Box = { w: tw + PAD * 2, h: ry - GAP + PAD };
      providerChildren.push({
        zone: {
          id: targetNodeId,
          type: 'zone',
          parentId: providerId,
          position: { x: PAD, y: ty },
          data: { label: targetNames.get(targetId) ?? targetFallback(shortId(targetId)), level: 'target' },
          style: { width: tBox.w, height: tBox.h },
          draggable: false,
          selectable: false,
        },
        children: targetChildren,
      });
      ty += tBox.h + GAP;
      pw = Math.max(pw, tBox.w);
    }
    const pBox: Box = { w: pw + PAD * 2, h: ty - GAP + PAD };
    zones.push({
      id: providerId,
      type: 'zone',
      position: { x: px, y: 0 },
      data: { label: provider, level: 'provider', provider, simulated },
      style: { width: pBox.w, height: pBox.h },
      draggable: false,
      selectable: false,
    });
    for (const c of providerChildren) {
      zones.push(c.zone);
      for (const child of c.children) {
        if (child.type === 'zone') zones.push(child as ZoneNode);
        else nodes.push(child as ResNode);
      }
    }
    px += pBox.w + 64;
  }
  return [...zones, ...nodes] as (ZoneNode | ResNode)[];
}

const ZoneView = memo(function ZoneView({ data }: NodeProps<ZoneNode>) {
  const t = useTranslations('topology');
  return (
    <div
      className={cn(
        'h-full w-full rounded-lg border',
        data.level === 'provider' && 'border-border-strong bg-surface/40',
        data.level === 'target' && 'border-border bg-surface-2/40',
        data.level === 'region' && 'border-dashed border-border-strong bg-transparent',
      )}
    >
      <div className="flex h-7 items-center gap-1.5 px-3 text-[11px]">
        {data.level === 'provider' && data.provider ? <ProviderLogo provider={data.provider} size={14} /> : null}
        <span className={cn(data.level === 'provider' ? 'font-display font-semibold uppercase tracking-wide text-fg' : data.level === 'region' ? 'font-mono text-fg-subtle' : 'font-medium text-fg-muted')}>
          {data.label}
        </span>
        {data.simulated ? <span className="rounded bg-accent/12 px-1 text-[9px] font-semibold uppercase tracking-wide text-accent-ink">{t('simulated')}</span> : null}
      </div>
    </div>
  );
});

const ResourceView = memo(function ResourceView({ data }: NodeProps<ResNode>) {
  const t = useTranslations('topology');
  const r = data.r;
  const drifted = r.drift && !['IN_SYNC', 'UNKNOWN', 'NONE', ''].includes(r.drift.toUpperCase());
  return (
    <div
      className={cn(
        'flex h-16 w-[220px] items-center gap-2.5 rounded-md border bg-surface px-2.5 shadow-card',
        r.health === 'UNHEALTHY' ? 'border-danger/60' : r.health === 'DEGRADED' ? 'border-warn/60' : 'border-border-strong',
      )}
      title={t('nodeTitle', { id: r.resourceId, name: r.capabilityName, health: r.health })}
    >
      <Handle type="target" position={Position.Left} className="!h-2 !w-2 !min-w-0 !border-0 !bg-transparent" isConnectable={false} />
      <ResourceIcon type={r.type} capability={r.capability} provider={r.provider} simulatedProvider={r.simulatedProvider} size={24} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium text-fg">{r.capabilityName}</p>
        <p className="flex items-center gap-1.5 truncate font-mono text-[10px] text-fg-subtle">
          <StatusDot status={r.health} className="h-1.5 w-1.5" />
          {r.resourceId}
        </p>
        <div className="mt-0.5 flex gap-1">
          {drifted ? <span className="rounded bg-warn/12 px-1 text-[9px] font-medium text-warn-ink">{t('drift')}</span> : null}
          {r.simulatedProvider || r.provider === 'mock' ? <span className="rounded bg-accent/12 px-1 text-[9px] font-medium text-accent-ink">{t('sim')}</span> : null}
        </div>
      </div>
      <Handle type="source" position={Position.Right} className="!h-2 !w-2 !min-w-0 !border-0 !bg-transparent" isConnectable={false} />
    </div>
  );
});

const nodeTypes = { zone: ZoneView, resource: ResourceView };

export default function TopologyDiagram({
  resources,
  document,
  connectivity,
  targetNames,
}: {
  resources: ResourceDto[];
  document: Record<string, unknown> | null;
  connectivity: PreviewDto['connectivity'] | null | undefined;
  targetNames: Map<string, string>;
}) {
  const t = useTranslations('topology');
  const theme = useTheme();
  const graph = useMemo(() => topologyEdges(resources, document, connectivity), [resources, document, connectivity]);
  const targetFallback = useMemo(() => (id: string) => t('targetFallback', { id }), [t]);
  const nodes = useMemo(() => buildGraph(resources, graph, targetNames, targetFallback), [resources, graph, targetNames, targetFallback]);
  const ariaLabelConfig = useMemo(
    () => ({
      'controls.ariaLabel': t('controls.label'),
      'controls.zoomIn.ariaLabel': t('controls.zoomIn'),
      'controls.zoomOut.ariaLabel': t('controls.zoomOut'),
      'controls.fitView.ariaLabel': t('controls.fitView'),
    }),
    [t],
  );
  const edges: Edge[] = useMemo(
    () =>
      graph.map((e) =>
        e.kind === 'connectivity'
          ? {
              id: e.id,
              source: e.from,
              target: e.to,
              label: e.label,
              zIndex: 2,
              style: { stroke: e.crossCloud ? 'var(--info)' : 'var(--fg-subtle)', strokeWidth: 1.5, strokeDasharray: e.crossCloud ? '6 4' : undefined },
              markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: e.crossCloud ? 'var(--info)' : 'var(--fg-subtle)' },
              labelBgPadding: [4, 2] as [number, number],
            }
          : {
              id: e.id,
              source: e.from,
              target: e.to,
              zIndex: 1,
              style: { stroke: 'var(--border-strong)', strokeWidth: 1 },
              markerEnd: { type: MarkerType.Arrow, width: 12, height: 12, color: 'var(--border-strong)' },
            },
      ),
    [graph],
  );
  const crossCloud = graph.filter((e) => e.crossCloud).length;

  return (
    <div className="space-y-2">
      <div className="bg-grid h-[560px] overflow-hidden rounded-md border border-border" aria-label={t('diagramLabel')}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          ariaLabelConfig={ariaLabelConfig}
          nodeTypes={nodeTypes}
          colorMode={theme}
          fitView
          fitViewOptions={{ padding: 0.12 }}
          minZoom={0.2}
          maxZoom={1.6}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          proOptions={{ hideAttribution: false }}
        >
          <Background gap={32} size={1} color="var(--border)" />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-fg-subtle">
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-px w-5 bg-fg-subtle" /> {t('legendConnectivity')}
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="inline-block w-5 border-t border-dashed border-info" /> {t('legendCrossCloud', { count: crossCloud })}
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-px w-5 bg-border-strong" /> {t('legendDependency')}
        </span>
        {connectivity ? null : <span>{t('runPreviewForLabels')}</span>}
      </p>
    </div>
  );
}
