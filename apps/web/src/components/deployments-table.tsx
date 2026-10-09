'use client';

import type { DeploymentSummaryDto, Page } from '@co/contracts';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Rocket } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'use-intl';
import { useFormat } from '@/i18n/format';
import { apiGet } from '@/lib/api';
import { isDeploymentActive } from '@/lib/status';
import { durationBetween, shortId } from '@/lib/utils';
import { Badge, SimulatedBadge } from './ui/badge';
import { Button } from './ui/button';
import { EmptyState } from './ui/empty-state';
import { ErrorNotice } from './ui/error-notice';
import { PageSpinner } from './ui/spinner';
import { StatusBadge } from './ui/status-badge';
import { Table, TBody, TD, TH, THead, TR } from './ui/table';

/** Cursor-paginated deployments (`Page<DeploymentSummaryDto>`); polls while any is active. */
export function useDeploymentPages(basePath: string, params: Record<string, string | undefined> = {}) {
  return useInfiniteQuery({
    queryKey: ['deployments', basePath, params],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }) => {
      const sp = new URLSearchParams({ limit: '25' });
      for (const [k, v] of Object.entries(params)) if (v) sp.set(k, v);
      if (pageParam) sp.set('cursor', pageParam);
      const data = await apiGet<Page<DeploymentSummaryDto> | DeploymentSummaryDto[]>(`${basePath}?${sp}`, { signal });
      return Array.isArray(data) ? { items: data, nextCursor: null } : data;
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: (query) => (query.state.data?.pages.some((p) => p.items.some((d) => isDeploymentActive(d.status))) ? 3000 : 20_000),
  });
}

export function DeploymentsList({ basePath, params, showInstance = true }: { basePath: string; params?: Record<string, string | undefined>; showInstance?: boolean }) {
  const t = useTranslations('deployments');
  const tc = useTranslations('common');
  const q = useDeploymentPages(basePath, params);
  if (q.isPending) return <PageSpinner />;
  if (q.error) return <ErrorNotice error={q.error} className="m-4" />;
  const items = q.data.pages.flatMap((p) => p.items);
  if (items.length === 0) return <EmptyState icon={Rocket} title={t('emptyTitle')} description={t('emptyBody')} />;
  return (
    <>
      <DeploymentsTable deployments={items} showInstance={showInstance} />
      {q.hasNextPage ? (
        <div className="flex justify-center border-t border-border p-3">
          <Button size="sm" onClick={() => q.fetchNextPage()} loading={q.isFetchingNextPage}>
            {tc('loadMore')}
          </Button>
        </div>
      ) : null}
    </>
  );
}

export function DeploymentsTable({ deployments, showInstance = true }: { deployments: DeploymentSummaryDto[]; showInstance?: boolean }) {
  const t = useTranslations('deployments');
  const fmt = useFormat();
  return (
    <Table>
      <THead>
        <tr>
          <TH>{t('table.deployment')}</TH>
          {showInstance ? <TH>{t('table.instance')}</TH> : null}
          <TH>{t('table.kind')}</TH>
          <TH>{t('table.status')}</TH>
          <TH>{t('table.queued')}</TH>
          <TH>{t('table.duration')}</TH>
          <TH>{t('table.error')}</TH>
        </tr>
      </THead>
      <TBody>
        {deployments.map((d) => (
          <TR key={d.id}>
            <TD>
              <div className="flex items-center gap-2">
                <Link href={`/deployments/${d.id}`} className="font-mono text-xs font-medium text-accent-ink hover:underline">
                  {shortId(d.id)}
                </Link>
                {d.simulated ? <SimulatedBadge /> : null}
              </div>
            </TD>
            {showInstance ? (
              <TD>
                <Link href={`/instances/${d.instanceId}`} className="font-mono text-xs text-fg-muted hover:text-accent-ink hover:underline">
                  {shortId(d.instanceId)}
                </Link>
              </TD>
            ) : null}
            <TD>
              <Badge tone={d.kind === 'DESTROY' ? 'danger' : 'neutral'}>{t(`kind.${d.kind}`)}</Badge>
            </TD>
            <TD>
              <StatusBadge status={d.status} />
            </TD>
            <TD className="whitespace-nowrap text-xs text-fg-muted">{fmt.dateTime(d.queuedAt)}</TD>
            <TD className="whitespace-nowrap text-xs tabular-nums text-fg-muted">{d.startedAt ? fmt.duration(durationBetween(d.startedAt, d.finishedAt)) : fmt.empty}</TD>
            <TD className="max-w-xs truncate text-xs text-danger-ink" title={d.errorMessage ?? undefined}>
              {d.errorMessage ?? ''}
            </TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}
