'use client';

import type { EChartsOption } from 'echarts';
import { BarChart, CustomChart, LineChart } from 'echarts/charts';
import { AriaComponent, DataZoomComponent, GridComponent, LegendComponent, MarkLineComponent, TooltipComponent } from 'echarts/components';
import * as echarts from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { useEffect, useMemo, useRef } from 'react';
import { readTokens, useTheme } from '@/lib/theme';
import { cn } from '@/lib/utils';

// Only what the console uses is registered (keeps the lazily loaded chunk small).
echarts.use([BarChart, LineChart, CustomChart, GridComponent, TooltipComponent, LegendComponent, DataZoomComponent, MarkLineComponent, AriaComponent, CanvasRenderer]);

const TOKEN_NAMES = [
  'surface',
  'surface-2',
  'border',
  'border-strong',
  'fg',
  'fg-muted',
  'fg-subtle',
  'accent',
  'ok',
  'warn',
  'danger',
  'info',
  'neutral',
  'chart-1',
  'chart-2',
  'chart-3',
] as const;
export type ChartTokens = Record<(typeof TOKEN_NAMES)[number], string> & { theme: 'dark' | 'light' };

/** Resolved CSS tokens for the current theme; changes identity when the theme toggles. */
export function useChartTokens(): ChartTokens | null {
  const theme = useTheme();
  return useMemo(() => {
    if (typeof document === 'undefined') return null;
    return { ...readTokens(TOKEN_NAMES), theme };
  }, [theme]);
}

/** Status colours (reserved: only where the colour means healthy/degraded/failed). */
export function statusColor(t: ChartTokens, status: string): string {
  switch (status.toUpperCase()) {
    case 'HEALTHY':
    case 'SUCCEEDED':
    case 'OPERATIONAL':
      return t.ok;
    case 'DEGRADED':
    case 'PARTIALLY_FAILED':
      return t.warn;
    case 'UNHEALTHY':
    case 'FAILED':
      return t.danger;
    case 'MAINTENANCE':
    case 'RUNNING':
      return t.info;
    default:
      return t.neutral;
  }
}

/** Categorical slots in fixed order (validated all-pairs for up to three series). */
export function seriesColor(t: ChartTokens, slot: number): string {
  return [t['chart-1'], t['chart-2'], t['chart-3']][slot % 3]!;
}

export function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Tooltip row: value leads (strong), series name follows, keyed by a short line stroke. */
export function tooltipRow(color: string, label: string, value: string): string {
  return `<div style="display:flex;align-items:center;gap:8px;line-height:1.5"><span style="display:inline-block;width:12px;height:2px;border-radius:1px;background:${color}"></span><strong style="font-variant-numeric:tabular-nums">${escapeHtml(value)}</strong><span style="opacity:.75">${escapeHtml(label)}</span></div>`;
}

/** Chart chrome shared by every chart: recessive axes, hairline grid, tokenised tooltip. */
export function baseOption(t: ChartTokens): EChartsOption {
  return {
    backgroundColor: 'transparent',
    animationDuration: 300,
    textStyle: { fontFamily: "'Inter Variable', ui-sans-serif, system-ui, sans-serif", color: t['fg-muted'], fontSize: 11 },
    grid: { left: 8, right: 16, top: 16, bottom: 8, containLabel: true },
    aria: { enabled: true },
    tooltip: {
      backgroundColor: t.surface,
      borderColor: t['border-strong'],
      borderWidth: 1,
      padding: [6, 10],
      textStyle: { color: t.fg, fontSize: 12 },
      extraCssText: 'box-shadow:0 4px 16px rgb(0 0 0 / .25);border-radius:6px;',
    },
  };
}

export function axisStyle(t: ChartTokens) {
  return {
    axisLine: { lineStyle: { color: t['border-strong'] } },
    axisTick: { show: false },
    axisLabel: { color: t['fg-subtle'], fontSize: 11 },
    splitLine: { lineStyle: { color: t.border, width: 1 } },
  };
}

/**
 * Minimal ECharts host: init on mount, ResizeObserver-driven resize, dispose on unmount, and a
 * full re-render when the option (or the theme, via `option(tokens)`) changes.
 */
export function EChart({
  option,
  height = 220,
  className,
  ariaLabel,
  preserveZoom = false,
}: {
  option: (tokens: ChartTokens) => EChartsOption;
  height?: number;
  className?: string;
  ariaLabel: string;
  /** Keep the zoom window across data refreshes (theme changes still re-render fully). */
  preserveZoom?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const tokens = useChartTokens();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const chart = echarts.init(el, undefined, { renderer: 'canvas' });
    chartRef.current = chart;
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(el);
    return () => {
      ro.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  const lastTokens = useRef<ChartTokens | null>(null);
  useEffect(() => {
    if (!chartRef.current || !tokens) return;
    const themeChanged = lastTokens.current !== tokens;
    lastTokens.current = tokens;
    if (preserveZoom && !themeChanged) chartRef.current.setOption(option(tokens), { replaceMerge: ['series'] });
    else chartRef.current.setOption(option(tokens), { notMerge: true });
  }, [option, tokens, preserveZoom]);

  return <div ref={ref} role="img" aria-label={ariaLabel} className={cn('w-full', className)} style={{ height }} />;
}

/** Screen-reader / no-hover alternative: every charted value is reachable as a table. */
export function DataTable({ caption, columns, rows }: { caption: string; columns: string[]; rows: (string | number)[][] }) {
  return (
    <details className="mt-2 text-xs">
      <summary className="text-fg-subtle hover:text-fg">View data table</summary>
      <div className="mt-2 max-h-56 overflow-auto rounded border border-border">
        <table className="w-full text-left">
          <caption className="sr-only">{caption}</caption>
          <thead className="bg-surface-2 text-fg-subtle">
            <tr>
              {columns.map((c) => (
                <th key={c} scope="col" className="px-2 py-1 font-medium">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((r, i) => (
              <tr key={i}>
                {r.map((v, j) => (
                  <td key={j} className={cn('px-2 py-1', typeof v === 'number' && 'text-right tabular-nums')}>
                    {v}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
