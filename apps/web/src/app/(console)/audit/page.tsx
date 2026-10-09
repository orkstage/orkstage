'use client';

import type { AuditEventDto, Page } from '@co/contracts';
import { useInfiniteQuery } from '@tanstack/react-query';
import { ScrollText } from 'lucide-react';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { AuditTable } from '@/components/audit-table';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorNotice } from '@/components/ui/error-notice';
import { PageHeader } from '@/components/ui/page-header';
import { Select } from '@/components/ui/select';
import { PageSpinner } from '@/components/ui/spinner';
import { apiGet, qs } from '@/lib/api';
import { useTenants } from '@/lib/queries';

export default function AuditPage() {
  const t = useTranslations('auditPage');
  const tc = useTranslations('common');
  const [tenantId, setTenantId] = useState('');
  const tenants = useTenants();
  const q = useInfiniteQuery({
    queryKey: ['audit', tenantId],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => apiGet<Page<AuditEventDto>>(`/audit${qs({ limit: 50, tenantId: tenantId || undefined, cursor: pageParam })}`, { signal }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const events = q.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      {(tenants.data?.length ?? 0) > 0 ? (
        <div className="mb-3">
          <label htmlFor="audit-tenant" className="mb-1 block text-xs text-fg-subtle">
            {t('tenant')}
          </label>
          <Select id="audit-tenant" value={tenantId} onChange={(e) => setTenantId(e.target.value)} className="w-56">
            <option value="">{t('allTenants')}</option>
            {tenants.data!.map((tenant) => (
              <option key={tenant.id} value={tenant.id}>
                {tenant.name}
              </option>
            ))}
          </Select>
        </div>
      ) : null}
      <Card>
        {q.isPending ? (
          <PageSpinner />
        ) : q.error ? (
          <ErrorNotice error={q.error} className="m-4" />
        ) : events.length === 0 ? (
          <EmptyState icon={ScrollText} title={t('emptyTitle')} description={t('emptyBody')} />
        ) : (
          <>
            <AuditTable events={events} />
            <div className="flex items-center justify-between border-t border-border px-4 py-3 text-xs text-fg-subtle">
              <span>{t('loaded', { count: events.length })}</span>
              {q.hasNextPage ? (
                <Button size="sm" onClick={() => q.fetchNextPage()} loading={q.isFetchingNextPage}>
                  {tc('loadMore')}
                </Button>
              ) : (
                <span>{t('end')}</span>
              )}
            </div>
          </>
        )}
      </Card>
    </>
  );
}
