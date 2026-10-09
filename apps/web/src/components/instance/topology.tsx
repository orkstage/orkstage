'use client';

import type { InstanceDto, PreviewDto, ResourceDto } from '@co/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ClipboardCopy, FlaskConical, Layers, LayoutList, Workflow } from 'lucide-react';
import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useFormat } from '@/i18n/format';
import { apiSend } from '@/lib/api';
import { useCloudTargets, useTemplate } from '@/lib/queries';
import { useDismiss } from '@/lib/hooks';
import { cn, displayOutput, shortId } from '@/lib/utils';
import { Badge, SimulatedBadge } from '../ui/badge';
import { CopyButton } from '../ui/copy-button';
import { EmptyState } from '../ui/empty-state';
import { ErrorNotice } from '../ui/error-notice';
import { PageSpinner, Spinner } from '../ui/spinner';
import { ResourceIcon } from '../resource-icon';
import { StatusBadge } from '../ui/status-badge';

type Grouped = Map<string, Map<string, Map<string, ResourceDto[]>>>;

/** Mock resources are grouped under the cloud they simulate (labelled as simulated). */
const providerKey = (r: ResourceDto) => (r.simulatedProvider ? `sim:${r.simulatedProvider}` : r.provider);

function group(resources: ResourceDto[]): Grouped {
  const out: Grouped = new Map();
  for (const r of resources) {
    const key = providerKey(r);
    const byTarget = out.get(key) ?? new Map<string, Map<string, ResourceDto[]>>();
    const byRegion = byTarget.get(r.targetId) ?? new Map<string, ResourceDto[]>();
    byRegion.set(r.region, [...(byRegion.get(r.region) ?? []), r]);
    byTarget.set(r.targetId, byRegion);
    out.set(key, byTarget);
  }
  return out;
}

// React Flow + dagre load only when the diagram view is shown.
const TopologyDiagram = dynamic(() => import('./topology-diagram'), { ssr: false, loading: () => <DiagramLoading /> });

function DiagramLoading() {
  const t = useTranslations('topology');
  return <PageSpinner label={t('drawing')} />;
}

type View = 'diagram' | 'list';
const VIEW_KEY = 'orkstage-topology-view';

export function Topology({
  instance,
  canSimulate,
  connectivity,
}: {
  instance: InstanceDto;
  canSimulate: boolean;
  connectivity?: PreviewDto['connectivity'] | null;
}) {
  const t = useTranslations('topology');
  // Customers cannot list cloud targets; fall back to the target id when names are unavailable.
  const targets = useCloudTargets();
  const targetName = useMemo(() => new Map((targets.data ?? []).map((t) => [t.id, t.name])), [targets.data]);
  const resources = useMemo(() => instance.resources ?? [], [instance.resources]);
  const template = useTemplate(instance.template.id);
  const document = template.data?.versions?.find((v) => v.id === instance.template.versionId)?.document ?? null;
  const [view, setView] = useState<View>('diagram');
  const [copied, setCopied] = useState<'ok' | 'error' | null>(null);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(VIEW_KEY);
      if (saved === 'list' || saved === 'diagram') setView(saved);
    } catch {
      /* default view */
    }
  }, []);
  const choose = (v: View) => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* ignore */
    }
  };

  const copyMermaid = async () => {
    try {
      const { topologyEdges, topologyToMermaid } = await import('@/lib/topology-graph');
      const text = topologyToMermaid(resources, topologyEdges(resources, document, connectivity), targetName);
      await navigator.clipboard.writeText(text);
      setCopied('ok');
    } catch {
      setCopied('error');
    }
    setTimeout(() => setCopied(null), 2000);
  };

  if (resources.length === 0) {
    return (
      <EmptyState
        icon={Layers}
        title={t('emptyTitle')}
        description={t('emptyBody')}
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="inline-flex rounded-md border border-border bg-surface p-0.5" role="group" aria-label={t('viewLabel')}>
          {(['diagram', 'list'] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              onClick={() => choose(v)}
              className={cn('flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium', view === v ? 'bg-accent/10 text-accent-ink' : 'text-fg-muted hover:text-fg')}
            >
              {v === 'diagram' ? <Workflow size={13} aria-hidden /> : <LayoutList size={13} aria-hidden />}
              {v === 'diagram' ? t('diagram') : t('list')}
            </button>
          ))}
        </div>
        <button type="button" onClick={copyMermaid} className="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-fg-muted hover:bg-surface-2 hover:text-fg">
          <ClipboardCopy size={13} aria-hidden />
          <span aria-live="polite">{copied === 'ok' ? t('mermaidCopied') : copied === 'error' ? t('copyFailed') : t('copyMermaid')}</span>
        </button>
      </div>
      {view === 'diagram' ? (
        <TopologyDiagram resources={resources} document={document} connectivity={connectivity} targetNames={targetName} />
      ) : (
        <TopologyList resources={resources} instanceId={instance.id} canSimulate={canSimulate} targetName={targetName} />
      )}
    </div>
  );
}

function TopologyList({
  resources,
  instanceId,
  canSimulate,
  targetName,
}: {
  resources: ResourceDto[];
  instanceId: string;
  canSimulate: boolean;
  targetName: Map<string, string>;
}) {
  const t = useTranslations('topology');
  const grouped = group(resources);
  return (
    <div className="space-y-5">
      {[...grouped.entries()].map(([key, byTarget]) => {
        const simulated = key.startsWith('sim:');
        const provider = simulated ? key.slice(4) : key;
        return (
          <section key={key} aria-label={simulated ? t('providerSectionSimulated', { provider }) : t('providerSection', { provider })}>
            <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
              <span className="font-mono uppercase">{provider}</span>
              {simulated ? <SimulatedBadge /> : null}
            </h3>
            <div className="space-y-3">
              {[...byTarget.entries()].map(([targetId, byRegion]) => (
                <div key={targetId} className="rounded-lg border border-border">
                  {[...byRegion.entries()].map(([region, list]) => (
                    <div key={region} className="border-b border-border last:border-b-0">
                      <p className="flex flex-wrap items-center gap-2 bg-surface-2/60 px-3 py-1.5 text-xs">
                        <span className="font-medium">{targetName.get(targetId) ?? <span className="font-mono">{t('targetFallback', { id: shortId(targetId) })}</span>}</span>
                        <span className="text-fg-subtle">/</span>
                        <span className="font-mono text-fg-muted">{region}</span>
                        <span className="ml-auto text-fg-subtle">{t('resourceCount', { count: list.length })}</span>
                      </p>
                      <div className="grid gap-2 p-2 sm:grid-cols-2 2xl:grid-cols-3">
                        {list.map((r) => (
                          <ResourceCard key={r.resourceId} resource={r} instanceId={instanceId} canSimulate={canSimulate} />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

const KEY_OUTPUTS = 6;

function ResourceCard({ resource: r, instanceId, canSimulate }: { resource: ResourceDto; instanceId: string; canSimulate: boolean }) {
  const t = useTranslations('topology');
  const fmt = useFormat();
  const outputs = Object.entries(r.outputs ?? {});
  const drifted = r.drift && !['IN_SYNC', 'UNKNOWN', 'NONE', ''].includes(r.drift.toUpperCase());
  const simulated = r.simulatedProvider !== null || r.provider === 'mock';
  return (
    <article className={cn('rounded-md border bg-surface p-3', r.health === 'UNHEALTHY' ? 'border-danger/50' : r.health === 'DEGRADED' ? 'border-warn/50' : 'border-border')}>
      <header className="flex items-start justify-between gap-2">
        <ResourceIcon type={r.type} capability={r.capability} provider={r.provider} simulatedProvider={r.simulatedProvider} size={22} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <h4 className="truncate text-sm font-medium" title={r.capabilityName}>
            {r.capabilityName}
          </h4>
          <p className="truncate font-mono text-[11px] text-fg-subtle" title={t('slotTitle', { id: r.resourceId, type: r.type, slot: r.slot })}>
            {r.resourceId} · {r.type}
          </p>
        </div>
        {simulated && canSimulate ? <SimulateMenu instanceId={instanceId} resource={r} /> : null}
      </header>
      <div className="mt-2 flex flex-wrap gap-1">
        <StatusBadge status={r.status} prefix={t('statusPrefix')} />
        <StatusBadge status={r.health} prefix={t('healthPrefix')} />
        <StatusBadge status={r.knowledge} prefix={t('knowledgePrefix')} label={r.knowledge} />
        {drifted ? <StatusBadge status={r.drift} prefix={t('driftPrefix')} /> : null}
        {r.critical ? <Badge>{t('critical')}</Badge> : null}
      </div>
      {drifted && r.driftChanges?.length ? (
        <div className="mt-1.5 rounded border border-warn/40 bg-warn/8 px-2 py-1.5 text-xs">
          <p className="text-warn-ink">
            {t('driftChanged')}
            {r.driftCheckedAt ? <span className="text-fg-subtle"> · {fmt.relative(r.driftCheckedAt)}</span> : null}. {t('driftRedeploy')}
          </p>
          <ul className="mt-1 space-y-0.5 font-mono text-[11px] text-fg-muted">
            {r.driftChanges.slice(0, 4).map((c) => (
              <li key={`${c.action}:${c.address}`} className="truncate" title={c.address}>
                {c.action} {c.address.replace(/^module\.resource\./, '')}
              </li>
            ))}
            {r.driftChanges.length > 4 ? <li className="text-fg-subtle">{t('more', { count: r.driftChanges.length - 4 })}</li> : null}
          </ul>
        </div>
      ) : null}
      {r.healthMessage ? (
        <p className="mt-1.5 text-xs text-fg-muted">
          {r.healthMessage}
          {r.healthCheckedAt ? <span className="text-fg-subtle"> · {fmt.relative(r.healthCheckedAt)}</span> : null}
        </p>
      ) : null}
      {outputs.length > 0 ? (
        <dl className="mt-2 space-y-0.5 border-t border-border pt-2 text-xs">
          {outputs.slice(0, KEY_OUTPUTS).map(([k, v]) => {
            const d = displayOutput(k, v);
            return (
              <div key={k} className="flex min-w-0 items-center gap-2">
                <dt className="w-28 shrink-0 truncate text-fg-subtle" title={k}>
                  {k}
                </dt>
                <dd className="flex min-w-0 items-center gap-1">
                  {d.hidden ? (
                    <span className="italic text-fg-subtle">{t('hidden')}</span>
                  ) : (
                    <>
                      <code className={cn('truncate font-mono', d.reference ? 'text-info-ink' : 'text-fg-muted')} title={d.text}>
                        {d.text}
                      </code>
                      <CopyButton value={d.text} label={t('copyOutput', { name: k })} />
                    </>
                  )}
                </dd>
              </div>
            );
          })}
          {outputs.length > KEY_OUTPUTS ? <p className="text-fg-subtle">{t('more', { count: outputs.length - KEY_OUTPUTS })}</p> : null}
        </dl>
      ) : null}
    </article>
  );
}

function SimulateMenu({ instanceId, resource }: { instanceId: string; resource: ResourceDto }) {
  const t = useTranslations('topology');
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const qc = useQueryClient();
  const close = useCallback(() => setOpen(false), []);
  useDismiss(ref, open, close);

  const simulate = useMutation({
    mutationFn: (body: { health?: string | null; drift?: boolean }) => apiSend('POST', `/instances/${instanceId}/simulate`, { resourceId: resource.resourceId, ...body }),
    onSuccess: () => {
      setOpen(false);
      void qc.invalidateQueries({ queryKey: ['instance', instanceId] });
    },
  });

  const drifted = resource.drift === 'DRIFT_DETECTED';
  const actions: { label: string; body: { health?: string | null; drift?: boolean } }[] = [
    { label: t('actions.unhealthy'), body: { health: 'UNHEALTHY' } },
    { label: t('actions.degraded'), body: { health: 'DEGRADED' } },
    { label: t('actions.healthy'), body: { health: 'HEALTHY' } },
    { label: t('actions.clearHealth'), body: { health: null } },
    { label: drifted ? t('actions.clearDrift') : t('actions.introduceDrift'), body: { drift: !drifted } },
  ];

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="inline-flex h-6 items-center gap-1 rounded px-1.5 text-[11px] text-fg-subtle hover:bg-surface-2 hover:text-fg"
        title={t('simulateTitle')}
      >
        {simulate.isPending ? <Spinner size={11} /> : <FlaskConical size={12} aria-hidden />} {t('simulate')}
      </button>
      {open ? (
        <div role="menu" className="absolute right-0 z-20 mt-1 w-48 rounded-md border border-border bg-surface p-1 shadow-xl">
          {actions.map((a) => (
            <button
              key={a.label}
              role="menuitem"
              type="button"
              disabled={simulate.isPending}
              onClick={() => simulate.mutate(a.body)}
              className="block w-full rounded px-2.5 py-1.5 text-left text-xs hover:bg-surface-2"
            >
              {a.label}
            </button>
          ))}
          {simulate.error ? <ErrorNotice error={simulate.error} className="mt-1 text-xs" /> : null}
        </div>
      ) : null}
    </div>
  );
}
