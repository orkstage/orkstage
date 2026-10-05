'use client';

import type { ResourceDto } from '@co/contracts';
import { useQueries, useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import dynamic from 'next/dynamic';
import { useMemo, useState } from 'react';
import type { MetricSeries } from '../charts/metrics-chart';
import { apiGet, qs } from '@/lib/api';
import { cn, formatTime } from '@/lib/utils';
import { Button } from '../ui/button';
import { ErrorNotice } from '../ui/error-notice';
import { Select } from '../ui/select';
import { Spinner } from '../ui/spinner';

// ECharts loads only when the Metrics tab renders.
const MetricsChart = dynamic(() => import('../charts/metrics-chart'), { ssr: false, loading: () => <p className="py-8 text-center text-sm text-fg-subtle">Loading chart…</p> });

interface ChartPoint {
  t: number;
  v: number;
}

/* The logs/metrics endpoints are not typed in @co/contracts; accept the adapter shapes
 * (LogLine[] / MetricPoint[]) either bare or wrapped in { items | lines | points }. */

interface LogLine {
  at: string;
  level: string;
  message: string;
}

function unwrap(data: unknown, keys: string[]): unknown[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    for (const k of keys) {
      const v = (data as Record<string, unknown>)[k];
      if (Array.isArray(v)) return v;
    }
  }
  return [];
}

function normalizeLogs(data: unknown): LogLine[] {
  return unwrap(data, ['items', 'lines', 'logs']).map((raw) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    return {
      at: String(r.timestamp ?? r.at ?? r.time ?? ''),
      level: String(r.level ?? 'info'),
      message: String(r.message ?? r.line ?? ''),
    };
  });
}

function normalizePoints(data: unknown): { points: ChartPoint[]; unit: string } {
  const unit = data && typeof data === 'object' && !Array.isArray(data) && typeof (data as Record<string, unknown>).unit === 'string' ? String((data as Record<string, unknown>).unit) : '';
  const points = unwrap(data, ['points', 'items', 'series'])
    .map((raw) => {
      const r = (raw ?? {}) as Record<string, unknown>;
      const t = new Date(String(r.timestamp ?? r.at ?? r.t ?? '')).getTime();
      const v = Number(r.value ?? r.v);
      return { t, v };
    })
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v));
  return { points, unit };
}

function ResourcePicker({ id, resources, value, onChange }: { id: string; resources: ResourceDto[]; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs text-fg-subtle">
        Resource
      </label>
      <Select id={id} value={value} onChange={(e) => onChange(e.target.value)} className="w-64">
        {resources.map((r) => (
          <option key={r.resourceId} value={r.resourceId}>
            {r.resourceId} — {r.capabilityName}
          </option>
        ))}
      </Select>
    </div>
  );
}

const LEVEL_CLASS: Record<string, string> = {
  error: 'text-danger-ink',
  warn: 'text-warn-ink',
  warning: 'text-warn-ink',
  debug: 'text-fg-subtle',
};

export function LogsPanel({ instanceId, resources }: { instanceId: string; resources: ResourceDto[] }) {
  const [resourceId, setResourceId] = useState(resources[0]?.resourceId ?? '');
  const [limit, setLimit] = useState(200);
  const [follow, setFollow] = useState(false);
  const q = useQuery({
    queryKey: ['logs', instanceId, resourceId, limit],
    queryFn: async ({ signal }) => normalizeLogs(await apiGet<unknown>(`/instances/${instanceId}/logs${qs({ resourceId, limit })}`, { signal })),
    enabled: !!resourceId,
    refetchInterval: follow ? 5000 : false,
  });

  if (resources.length === 0) return <p className="text-sm text-fg-subtle">No resources yet. Logs are available after deployment.</p>;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <ResourcePicker id="logs-resource" resources={resources} value={resourceId} onChange={setResourceId} />
        <div>
          <label htmlFor="logs-limit" className="mb-1 block text-xs text-fg-subtle">
            Lines
          </label>
          <Select id="logs-limit" value={limit} onChange={(e) => setLimit(Number(e.target.value))} className="w-24">
            {[100, 200, 500].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
        </div>
        <label className="flex h-8 items-center gap-1.5 text-xs text-fg-muted">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} className="accent-accent" /> Auto-refresh (5s)
        </label>
        <Button size="sm" onClick={() => q.refetch()} disabled={q.isFetching}>
          {q.isFetching ? <Spinner size={12} /> : <RefreshCw size={12} aria-hidden />} Refresh
        </Button>
      </div>
      {q.error ? <ErrorNotice error={q.error} /> : null}
      <div role="log" aria-label="Resource logs" className="max-h-[32rem] overflow-auto rounded-md border border-border bg-surface-2/50 p-2 font-mono text-[11.5px] leading-relaxed">
        {q.isPending ? (
          <p className="p-2 text-fg-subtle">Loading…</p>
        ) : (q.data ?? []).length === 0 ? (
          <p className="p-2 text-fg-subtle">No log lines.</p>
        ) : (
          q.data!.map((l, i) => (
            <div key={i} className="flex gap-3 whitespace-pre-wrap break-all">
              <span className="shrink-0 text-fg-subtle">{formatTime(l.at)}</span>
              <span className={cn('w-10 shrink-0 uppercase', LEVEL_CLASS[l.level.toLowerCase()] ?? 'text-fg-muted')}>{l.level}</span>
              <span className="text-fg">{l.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

const METRICS = [
  { id: 'cpu', label: 'CPU', unit: '%' },
  { id: 'memory', label: 'Memory', unit: '%' },
  { id: 'requests', label: 'Requests / min', unit: '' },
  { id: 'errors', label: 'Errors / min', unit: '' },
  { id: 'latency', label: 'Latency p95', unit: ' ms' },
];

const MAX_COMPARE = 3;

/**
 * Metrics for up to three resources on one time axis. Each selected resource keeps the
 * colour slot it was given when selected, so deselecting one never repaints the others.
 */
export function MetricsPanel({ instanceId, resources }: { instanceId: string; resources: ResourceDto[] }) {
  const [selected, setSelected] = useState<{ id: string; slot: number }[]>(() => (resources[0] ? [{ id: resources[0].resourceId, slot: 0 }] : []));
  const [metric, setMetric] = useState('cpu');
  const [minutes, setMinutes] = useState(60);

  const queries = useQueries({
    queries: selected.map((s) => ({
      queryKey: ['metrics', instanceId, s.id, metric, minutes],
      queryFn: async ({ signal }: { signal: AbortSignal }) =>
        normalizePoints(await apiGet<unknown>(`/instances/${instanceId}/metrics${qs({ resourceId: s.id, metric, minutes })}`, { signal })),
      refetchInterval: 30_000,
    })),
  });

  const def = METRICS.find((m) => m.id === metric);

  const toggle = (id: string) => {
    setSelected((prev) => {
      if (prev.some((s) => s.id === id)) return prev.filter((s) => s.id !== id);
      if (prev.length >= MAX_COMPARE) return prev;
      const used = new Set(prev.map((s) => s.slot));
      const slot = [0, 1, 2].find((n) => !used.has(n)) ?? 0;
      return [...prev, { id, slot }];
    });
  };

  const fetching = queries.some((q) => q.isFetching);
  const error = queries.find((q) => q.error)?.error;
  const pending = queries.some((q) => q.isPending);
  const unit = queries.find((q) => q.data?.unit)?.data?.unit || def?.unit || '';
  // Stable identity between refetches so the chart keeps its zoom window and does not re-render needlessly.
  const dataKey = queries.map((q) => q.dataUpdatedAt).join(',');
  const series: MetricSeries[] = useMemo(
    () => selected.map((s, i) => ({ id: s.id, slot: s.slot, label: s.id, points: queries[i]?.data?.points ?? [] })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selected, dataKey],
  );

  if (resources.length === 0) return <p className="text-sm text-fg-subtle">No resources yet. Metrics are available after deployment.</p>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="metrics-metric" className="mb-1 block text-xs text-fg-subtle">
            Metric
          </label>
          <Select id="metrics-metric" value={metric} onChange={(e) => setMetric(e.target.value)} className="w-40">
            {METRICS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <label htmlFor="metrics-window" className="mb-1 block text-xs text-fg-subtle">
            Window
          </label>
          <Select id="metrics-window" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} className="w-32">
            <option value={15}>15 minutes</option>
            <option value={60}>1 hour</option>
            <option value={180}>3 hours</option>
            <option value={1440}>24 hours</option>
          </Select>
        </div>
        {fetching ? <Spinner size={14} label="Loading metrics" className="mb-2" /> : null}
      </div>
      <fieldset>
        <legend className="mb-1.5 text-xs text-fg-subtle">
          Resources to compare ({selected.length}/{MAX_COMPARE})
        </legend>
        <div className="flex flex-wrap gap-1.5">
          {resources.map((r) => {
            const sel = selected.find((s) => s.id === r.resourceId);
            const disabled = !sel && selected.length >= MAX_COMPARE;
            return (
              <label
                key={r.resourceId}
                className={cn(
                  'flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-xs',
                  sel ? 'border-border-strong bg-surface-2 text-fg' : 'border-border text-fg-muted hover:bg-surface-2',
                  disabled && 'cursor-not-allowed opacity-50',
                )}
                title={disabled ? `Compare up to ${MAX_COMPARE} resources` : r.capabilityName}
              >
                <input type="checkbox" className="sr-only" checked={!!sel} disabled={disabled} onChange={() => toggle(r.resourceId)} />
                <span aria-hidden className="h-0.5 w-3 rounded" style={{ background: sel ? `var(--chart-${sel.slot + 1})` : 'var(--border-strong)' }} />
                <span className="font-mono">{r.resourceId}</span>
              </label>
            );
          })}
        </div>
      </fieldset>
      {error ? (
        <ErrorNotice error={error} />
      ) : selected.length === 0 ? (
        <p className="py-8 text-center text-sm text-fg-subtle">Select at least one resource.</p>
      ) : pending ? (
        <p className="py-8 text-center text-sm text-fg-subtle">Loading…</p>
      ) : (
        <MetricsChart series={series} unit={unit} metricLabel={def?.label ?? metric} />
      )}
    </div>
  );
}
