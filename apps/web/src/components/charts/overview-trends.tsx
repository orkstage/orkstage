'use client';

import type { EChartsOption } from 'echarts';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { Card, CardBody, CardHeader, StatCard } from '@/components/ui/card';
import { ErrorNotice } from '@/components/ui/error-notice';
import { PageSpinner } from '@/components/ui/spinner';
import { apiGet, isApiError } from '@/lib/api';
import { statusLabel } from '@/lib/status';
import { cn, formatMoney } from '@/lib/utils';
import { axisStyle, baseOption, DataTable, EChart, seriesColor, statusColor, tooltipRow, type ChartTokens } from './echart';

export interface OverviewTrendsDto {
  deploymentsByDay: { day: string; succeeded: number; failed: number; other: number }[];
  incidentsByDay: { day: string; opened: number; resolved: number }[];
  costByProvider: { provider: string; monthly: number }[];
  resourcesByHealth: Record<'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'UNKNOWN' | 'MAINTENANCE', number>;
}

const HEALTH_ORDER = ['HEALTHY', 'DEGRADED', 'UNHEALTHY', 'MAINTENANCE', 'UNKNOWN'] as const;
const HEALTH_DOT: Record<(typeof HEALTH_ORDER)[number], string> = {
  HEALTHY: 'bg-ok',
  DEGRADED: 'bg-warn',
  UNHEALTHY: 'bg-danger',
  MAINTENANCE: 'bg-info',
  UNKNOWN: 'bg-neutral',
};

const dayLabel = (day: string) => {
  const d = new Date(`${day}T00:00:00`);
  return Number.isNaN(d.getTime()) ? day : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

/** Platform trends (GET /overview/trends). Renders nothing alarming when the endpoint is absent. */
export default function OverviewTrends({ days = 14 }: { days?: number }) {
  const q = useQuery({
    queryKey: ['overview-trends', days],
    queryFn: ({ signal }) => apiGet<OverviewTrendsDto>(`/overview/trends?days=${days}`, { signal }),
    refetchInterval: 60_000,
    retry: false,
  });

  if (q.isPending) return <PageSpinner label="Loading trends" />;
  if (q.error) {
    if (isApiError(q.error, 404)) {
      return (
        <Card className="px-4 py-3 text-sm text-fg-subtle">
          Trend charts appear here once the control API serves <code className="font-mono text-xs">/overview/trends</code>.
        </Card>
      );
    }
    return <ErrorNotice error={q.error} title="Trends unavailable" />;
  }
  return <TrendsView data={q.data} days={days} />;
}

function TrendsView({ data, days }: { data: OverviewTrendsDto; days: number }) {
  const dep = data.deploymentsByDay;
  const inc = data.incidentsByDay;
  const totals = dep.reduce((s, d) => ({ ok: s.ok + d.succeeded, failed: s.failed + d.failed, other: s.other + d.other }), { ok: 0, failed: 0, other: 0 });
  const total = totals.ok + totals.failed + totals.other;
  const finished = totals.ok + totals.failed;
  const successRate = finished ? Math.round((totals.ok / finished) * 1000) / 10 : null;
  const opened = inc.reduce((s, d) => s + d.opened, 0);
  const resolved = inc.reduce((s, d) => s + d.resolved, 0);
  const cost = useMemo(() => [...data.costByProvider].sort((a, b) => b.monthly - a.monthly), [data.costByProvider]);
  const costTotal = cost.reduce((s, c) => s + c.monthly, 0);

  const deploymentsOption = useCallback(
    (t: ChartTokens): EChartsOption => {
      const keys = [
        { key: 'succeeded' as const, name: 'Succeeded', color: statusColor(t, 'SUCCEEDED') },
        { key: 'failed' as const, name: 'Failed', color: statusColor(t, 'FAILED') },
        { key: 'other' as const, name: 'Other', color: t.neutral },
      ];
      // 4px rounded data-end on whichever segment is on top for that day; square at the baseline.
      const topIndex = dep.map((d) => {
        for (let i = keys.length - 1; i >= 0; i--) if (d[keys[i]!.key] > 0) return i;
        return -1;
      });
      return {
        ...baseOption(t),
        grid: { left: 8, right: 8, top: 32, bottom: 4, containLabel: true },
        legend: { top: 0, left: 0, icon: 'rect', itemWidth: 10, itemHeight: 10, textStyle: { color: t['fg-muted'] } },
        tooltip: {
          ...baseOption(t).tooltip,
          trigger: 'axis',
          axisPointer: { type: 'shadow', shadowStyle: { color: t['surface-2'], opacity: 0.6 } },
          formatter: (params: unknown) => {
            const list = params as { dataIndex: number }[];
            const d = dep[list[0]?.dataIndex ?? 0];
            if (!d) return '';
            return `<div style="margin-bottom:4px;opacity:.75">${dayLabel(d.day)}</div>${keys.map((k) => tooltipRow(k.color, k.name, String(d[k.key]))).join('')}`;
          },
        },
        xAxis: { type: 'category', data: dep.map((d) => dayLabel(d.day)), ...axisStyle(t), splitLine: { show: false } },
        yAxis: { type: 'value', minInterval: 1, ...axisStyle(t), axisLine: { show: false } },
        series: keys.map((k, ki) => ({
          name: k.name,
          type: 'bar',
          stack: 'deployments',
          barMaxWidth: 24,
          color: k.color,
          itemStyle: { borderColor: t.surface, borderWidth: 1 },
          emphasis: { focus: 'series' },
          data: dep.map((d, di) => ({ value: d[k.key], itemStyle: { borderRadius: topIndex[di] === ki ? [4, 4, 0, 0] : 0 } })),
        })),
      };
    },
    [dep],
  );

  const incidentsOption = useCallback(
    (t: ChartTokens): EChartsOption => {
      const lines = [
        { key: 'opened' as const, name: 'Opened', color: seriesColor(t, 1) },
        { key: 'resolved' as const, name: 'Resolved', color: seriesColor(t, 0) },
      ];
      return {
        ...baseOption(t),
        grid: { left: 8, right: 16, top: 32, bottom: 4, containLabel: true },
        legend: { top: 0, left: 0, icon: 'path://M0,4 L14,4 L14,6 L0,6 Z', itemWidth: 14, itemHeight: 6, textStyle: { color: t['fg-muted'] } },
        tooltip: {
          ...baseOption(t).tooltip,
          trigger: 'axis',
          axisPointer: { type: 'line', lineStyle: { color: t['border-strong'], width: 1 } },
          formatter: (params: unknown) => {
            const list = params as { dataIndex: number }[];
            const d = inc[list[0]?.dataIndex ?? 0];
            if (!d) return '';
            return `<div style="margin-bottom:4px;opacity:.75">${dayLabel(d.day)}</div>${lines.map((l) => tooltipRow(l.color, l.name, String(d[l.key]))).join('')}`;
          },
        },
        xAxis: { type: 'category', boundaryGap: false, data: inc.map((d) => dayLabel(d.day)), ...axisStyle(t), splitLine: { show: false } },
        yAxis: { type: 'value', minInterval: 1, ...axisStyle(t), axisLine: { show: false } },
        series: lines.map((l) => ({
          name: l.name,
          type: 'line',
          color: l.color,
          data: inc.map((d) => d[l.key]),
          lineStyle: { width: 2, cap: 'round', join: 'round' },
          symbol: 'circle',
          symbolSize: 8,
          showSymbol: false,
          itemStyle: { borderColor: t.surface, borderWidth: 2 },
          emphasis: { focus: 'series' },
        })),
      };
    },
    [inc],
  );

  const costOption = useCallback(
    (t: ChartTokens): EChartsOption => ({
      ...baseOption(t),
      grid: { left: 8, right: 72, top: 4, bottom: 4, containLabel: true },
      tooltip: {
        ...baseOption(t).tooltip,
        trigger: 'item',
        formatter: (p: unknown) => {
          const item = p as { name: string; value: number };
          return tooltipRow(seriesColor(t, 0), `${item.name} · approximate monthly`, formatMoney(item.value));
        },
      },
      xAxis: { type: 'value', ...axisStyle(t), axisLabel: { show: false }, splitLine: { show: false } },
      yAxis: { type: 'category', inverse: true, data: cost.map((c) => c.provider), ...axisStyle(t), axisLabel: { color: t['fg-muted'], fontSize: 11 } },
      series: [
        {
          type: 'bar',
          barMaxWidth: 20,
          color: seriesColor(t, 0),
          itemStyle: { borderRadius: [0, 4, 4, 0] },
          label: { show: true, position: 'right', color: t['fg-muted'], formatter: (p: { value: unknown }) => formatMoney(Number(p.value)) },
          data: cost.map((c) => c.monthly),
        },
      ],
    }),
    [cost],
  );

  const health = data.resourcesByHealth;
  const healthTotal = HEALTH_ORDER.reduce((s, k) => s + (health[k] ?? 0), 0);

  return (
    <section aria-labelledby="trends-heading" className="space-y-3">
      <h2 id="trends-heading" className="font-display text-base font-semibold">
        Last {days} days
      </h2>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Deployments" value={total.toLocaleString()} hint={`${totals.failed} failed`} />
        <StatCard label="Deployment success rate" value={successRate === null ? '—' : `${successRate}%`} hint="Succeeded ÷ finished" />
        <StatCard label="Incidents opened" value={opened} hint={`${resolved} resolved`} />
        <StatCard label="Est. monthly cost" value={formatMoney(costTotal)} hint="Approximate — not an invoice" />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Deployments per day" description="Finished rollouts and teardowns, by outcome." as="h3" />
          <CardBody>
            <EChart option={deploymentsOption} height={220} ariaLabel={`Deployments per day over the last ${days} days: ${totals.ok} succeeded, ${totals.failed} failed, ${totals.other} other`} />
            <DataTable caption="Deployments per day" columns={['Day', 'Succeeded', 'Failed', 'Other']} rows={dep.map((d) => [d.day, d.succeeded, d.failed, d.other])} />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Incidents opened vs resolved" description="A widening gap means incidents are piling up." as="h3" />
          <CardBody>
            <EChart option={incidentsOption} height={220} ariaLabel={`Incidents over the last ${days} days: ${opened} opened, ${resolved} resolved`} />
            <DataTable caption="Incidents per day" columns={['Day', 'Opened', 'Resolved']} rows={inc.map((d) => [d.day, d.opened, d.resolved])} />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Estimated cost by provider" description="Approximate monthly run-rate of everything deployed." as="h3" />
          <CardBody>
            {cost.length === 0 ? (
              <p className="py-6 text-center text-sm text-fg-subtle">No deployed resources with a cost estimate.</p>
            ) : (
              <EChart option={costOption} height={Math.max(96, cost.length * 36 + 16)} ariaLabel={`Approximate monthly cost by provider: ${cost.map((c) => `${c.provider} ${formatMoney(c.monthly)}`).join(', ')}`} />
            )}
            <DataTable caption="Approximate monthly cost by provider" columns={['Provider', 'Approximate monthly (USD)']} rows={cost.map((c) => [c.provider, Math.round(c.monthly * 100) / 100])} />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Resource health" description={`${healthTotal} resources across the fleet.`} as="h3" />
          <CardBody>
            <HealthBar health={health} total={healthTotal} />
          </CardBody>
        </Card>
      </div>
    </section>
  );
}

/** Part-to-whole at a glance: a segmented bar with a 2px surface gap and a labelled legend. */
function HealthBar({ health, total }: { health: OverviewTrendsDto['resourcesByHealth']; total: number }) {
  if (total === 0) return <p className="py-6 text-center text-sm text-fg-subtle">No resources are being watched yet.</p>;
  const parts = HEALTH_ORDER.map((k) => ({ key: k, n: health[k] ?? 0 })).filter((p) => p.n > 0);
  return (
    <div className="space-y-4">
      <div className="flex h-3 w-full gap-0.5 overflow-hidden rounded" role="img" aria-label={parts.map((p) => `${statusLabel(p.key)} ${p.n}`).join(', ')}>
        {parts.map((p, i) => (
          <span
            key={p.key}
            title={`${statusLabel(p.key)}: ${p.n}`}
            className={cn('h-full', HEALTH_DOT[p.key], i === 0 && 'rounded-l', i === parts.length - 1 && 'rounded-r')}
            style={{ width: `${(p.n / total) * 100}%` }}
          />
        ))}
      </div>
      <ul className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
        {HEALTH_ORDER.map((k) => (
          <li key={k} className="flex items-center gap-2">
            <span aria-hidden className={cn('h-2.5 w-2.5 rounded-sm', HEALTH_DOT[k])} />
            <span className="text-fg-muted">{statusLabel(k)}</span>
            <span className="ml-auto font-medium tabular-nums text-fg">{health[k] ?? 0}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
