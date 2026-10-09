'use client';

import type { DeploymentStepDto } from '@co/contracts';
import type { CustomSeriesRenderItem, EChartsOption } from 'echarts';
import { useCallback, useMemo } from 'react';
import { useTranslations } from 'use-intl';
import { useFormat } from '@/i18n/format';
import { useStatusLabel } from '@/i18n/labels';
import { durationBetween } from '@/lib/utils';
import { axisStyle, baseOption, DataTable, EChart, escapeHtml, statusColor, type ChartTokens } from './echart';

const ROW = 26;

/** Gantt style timeline: one bar per started step, from start to finish (or now while running). */
export default function DeploymentGantt({ steps, now }: { steps: DeploymentStepDto[]; now: number }) {
  const t = useTranslations('charts');
  const fmt = useFormat();
  const statusLabel = useStatusLabel();
  const ordered = useMemo(() => [...steps].sort((a, b) => a.position - b.position), [steps]);
  const started = ordered.filter((s) => s.startedAt);

  const option = useCallback(
    (tokens: ChartTokens): EChartsOption => {
      const renderItem: CustomSeriesRenderItem = (_params, api) => {
        const row = api.value(0) as number;
        const start = api.coord([api.value(1), row]);
        const end = api.coord([api.value(2), row]);
        const band = (api.size?.([0, 1]) as number[] | undefined)?.[1] ?? ROW;
        const h = Math.min(14, band * 0.6);
        const width = Math.max(3, (end[0] ?? 0) - (start[0] ?? 0));
        return {
          type: 'rect',
          shape: { x: start[0] ?? 0, y: (start[1] ?? 0) - h / 2, width, height: h, r: [2, 4, 4, 2] },
          style: { fill: api.visual('color') as string },
        };
      };
      return {
        ...baseOption(tokens),
        animation: false,
        grid: { left: 8, right: 24, top: 8, bottom: 4, containLabel: true },
        tooltip: {
          ...baseOption(tokens).tooltip,
          trigger: 'item',
          formatter: (p: unknown) => {
            const s = ordered[(p as { value: number[] }).value[0] ?? 0];
            if (!s) return '';
            const dur = fmt.duration(durationBetween(s.startedAt, s.finishedAt, now));
            const where = s.provider ? `${s.provider}${s.region ? ` / ${s.region}` : ''}` : '';
            return `<div style="line-height:1.5"><strong>${escapeHtml(dur)}</strong> <span style="opacity:.75">${escapeHtml(s.name)}</span><br/><span style="opacity:.75">${escapeHtml(statusLabel(s.status))}${where ? ` · ${escapeHtml(where)}` : ''}${s.attempt > 1 ? ` · ${escapeHtml(t('attempt', { attempt: s.attempt }))}` : ''}</span></div>`;
          },
        },
        xAxis: {
          type: 'time',
          ...axisStyle(tokens),
          axisLabel: { color: tokens['fg-subtle'], fontSize: 10, hideOverlap: true, formatter: (v: number) => fmt.time(new Date(v).toISOString()) },
        },
        yAxis: {
          type: 'category',
          inverse: true,
          data: ordered.map((s) => s.name),
          ...axisStyle(tokens),
          splitLine: { show: false },
          axisLabel: { color: tokens['fg-muted'], fontSize: 11, width: 170, overflow: 'truncate' },
        },
        series: [
          {
            type: 'custom',
            renderItem,
            encode: { x: [1, 2], y: 0 },
            data: ordered.flatMap((s, i) =>
              s.startedAt
                ? [
                    {
                      value: [i, new Date(s.startedAt).getTime(), s.finishedAt ? new Date(s.finishedAt).getTime() : now],
                      itemStyle: { color: s.status === 'SKIPPED' || s.status === 'CANCELLED' ? tokens.neutral : statusColor(tokens, s.status) },
                    },
                  ]
                : [],
            ),
          },
        ],
      };
    },
    [ordered, now, t, fmt, statusLabel],
  );

  if (started.length === 0) return <p className="px-4 py-3 text-xs text-fg-subtle">{t('timelineEmpty')}</p>;

  return (
    <div className="px-2 pt-2">
      <EChart
        option={option}
        height={ordered.length * ROW + 36}
        ariaLabel={t('timelineAria', { started: started.length, total: ordered.length })}
      />
      <div className="px-2 pb-1">
        <DataTable
          caption={t('timelineCaption')}
          columns={[t('step'), t('status'), t('started'), t('finished'), t('duration')]}
          rows={ordered.map((s) => [
            s.name,
            statusLabel(s.status),
            fmt.time(s.startedAt),
            fmt.time(s.finishedAt),
            s.startedAt ? fmt.duration(durationBetween(s.startedAt, s.finishedAt, now)) : fmt.empty,
          ])}
        />
      </div>
    </div>
  );
}
