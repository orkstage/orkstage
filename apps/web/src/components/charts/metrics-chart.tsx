'use client';

import type { EChartsOption } from 'echarts';
import { useCallback } from 'react';
import { useTranslations } from 'use-intl';
import { useFormat } from '@/i18n/format';
import { axisStyle, baseOption, DataTable, EChart, seriesColor, tooltipRow, type ChartTokens } from './echart';

export interface MetricSeries {
  id: string;
  label: string;
  /** Fixed categorical slot (0 to 2), assigned when the series was selected: colour follows the entity. */
  slot: number;
  points: { t: number; v: number }[];
}

/** Time series with crosshair tooltip and zoom (wheel/pinch + slider). Up to three series. */
export default function MetricsChart({ series, unit, metricLabel }: { series: MetricSeries[]; unit: string; metricLabel: string }) {
  const t = useTranslations('charts');
  const f = useFormat();
  const fmt = useCallback((v: number) => `${f.number(v)}${unit}`, [unit, f]);

  const option = useCallback(
    (t: ChartTokens): EChartsOption => ({
      ...baseOption(t),
      grid: { left: 8, right: 16, top: series.length > 1 ? 32 : 12, bottom: 48, containLabel: true },
      legend:
        series.length > 1
          ? { top: 0, left: 0, icon: 'path://M0,4 L14,4 L14,6 L0,6 Z', itemWidth: 14, itemHeight: 6, textStyle: { color: t['fg-muted'] } }
          : { show: false },
      tooltip: {
        ...baseOption(t).tooltip,
        trigger: 'axis',
        axisPointer: { type: 'line', lineStyle: { color: t['border-strong'], width: 1 } },
        formatter: (params: unknown) => {
          const list = params as { seriesIndex: number; value: [number, number] }[];
          const at = list[0]?.value[0];
          const rows = list
            .map((p) => {
              const s = series[p.seriesIndex];
              return s ? tooltipRow(seriesColor(t, s.slot), s.label, fmt(p.value[1])) : '';
            })
            .join('');
          return `<div style="margin-bottom:4px;opacity:.75">${at ? f.time(new Date(at).toISOString()) : ''}</div>${rows}`;
        },
      },
      xAxis: {
        type: 'time',
        ...axisStyle(t),
        splitLine: { show: false },
        axisLabel: { color: t['fg-subtle'], fontSize: 10, hideOverlap: true, formatter: (v: number) => f.shortTime(v) },
      },
      yAxis: { type: 'value', scale: false, ...axisStyle(t), axisLine: { show: false }, axisLabel: { color: t['fg-subtle'], fontSize: 10, formatter: (v: number) => fmt(v) } },
      dataZoom: [
        { type: 'inside', filterMode: 'none' },
        {
          type: 'slider',
          height: 18,
          bottom: 6,
          filterMode: 'none',
          borderColor: t.border,
          backgroundColor: 'transparent',
          fillerColor: `${t.accent}22`,
          handleStyle: { color: t.surface, borderColor: t['border-strong'] },
          moveHandleStyle: { color: t['border-strong'] },
          textStyle: { color: t['fg-subtle'], fontSize: 10 },
          dataBackground: { lineStyle: { color: t['border-strong'] }, areaStyle: { color: t['surface-2'] } },
          selectedDataBackground: { lineStyle: { color: t['fg-subtle'] }, areaStyle: { color: t['surface-2'] } },
          labelFormatter: (v: number) => f.time(new Date(v).toISOString()),
        },
      ],
      series: series.map((s) => ({
        name: s.label,
        type: 'line',
        color: seriesColor(t, s.slot),
        data: s.points.map((p) => [p.t, p.v]),
        lineStyle: { width: 2, cap: 'round', join: 'round' },
        symbol: 'circle',
        symbolSize: 8,
        showSymbol: false,
        itemStyle: { borderColor: t.surface, borderWidth: 2 },
        // A single series gets a faint area wash; comparisons stay lines only.
        areaStyle: series.length === 1 ? { color: seriesColor(t, s.slot), opacity: 0.1 } : undefined,
        emphasis: { focus: 'series' },
      })),
    }),
    [series, fmt, f],
  );

  const total = series.reduce((n, s) => n + s.points.length, 0);
  if (total === 0) return <p className="py-8 text-center text-sm text-fg-subtle">{t('noPoints')}</p>;

  const latest = series.map((s) => ({ s, last: s.points[s.points.length - 1] }));
  return (
    <figure className="space-y-2">
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-fg-subtle">
        {latest.map(({ s, last }) => (
          <span key={s.id}>
            {t('latest', { label: s.label })} <strong className="text-fg">{last ? fmt(last.v) : f.empty}</strong>
          </span>
        ))}
      </div>
      <EChart option={option} height={260} preserveZoom ariaLabel={t('metricAria', { metric: metricLabel, resources: series.map((s) => s.label).join(', ') })} />
      <figcaption className="sr-only">{metricLabel}</figcaption>
      <DataTable
        caption={metricLabel}
        columns={[t('resource'), t('time'), t('value')]}
        rows={series.flatMap((s) => s.points.map((p) => [s.label, f.time(new Date(p.t).toISOString()), f.number(p.v)]))}
      />
    </figure>
  );
}
