'use client';

import type { AuditEventDto, Page } from '@co/contracts';
import { useInfiniteQuery } from '@tanstack/react-query';
import { ScrollText } from 'lucide-react';
import { useState } from 'react';
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
      <PageHeader title="Audit log" description="Who did what, when, and whether it worked. Quote the correlation id when contacting support." />
      {(tenants.data?.length ?? 0) > 0 ? (
        <div className="mb-3">
          <label htmlFor="audit-tenant" className="mb-1 block text-xs text-fg-subtle">
            Tenant
          </label>
          <Select id="audit-tenant" value={tenantId} onChange={(e) => setTenantId(e.target.value)} className="w-56">
            <option value="">All tenants</option>
            {tenants.data!.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
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
          <EmptyState icon={ScrollText} title="No audit events yet" description="Sign-ins, deployments and configuration changes are recorded here." />
        ) : (
          <>
            <AuditTable events={events} />
            <div className="flex items-center justify-between border-t border-border px-4 py-3 text-xs text-fg-subtle">
              <span>{events.length} events loaded</span>
              {q.hasNextPage ? (
                <Button size="sm" onClick={() => q.fetchNextPage()} loading={q.isFetchingNextPage}>
                  Load more
                </Button>
              ) : (
                <span>End of log</span>
              )}
            </div>
          </>
        )}
      </Card>
    </>
  );
}
