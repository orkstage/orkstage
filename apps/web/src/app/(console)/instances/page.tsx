'use client';

import { Boxes, Plus } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { useTranslations } from 'use-intl';
import { useFormat } from '@/i18n/format';
import { useEnvironmentLabel, useStatusLabel } from '@/i18n/labels';
import { SimulatedBadge } from '@/components/ui/badge';
import { ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorNotice } from '@/components/ui/error-notice';
import { PageHeader } from '@/components/ui/page-header';
import { Select } from '@/components/ui/select';
import { PageSpinner } from '@/components/ui/spinner';
import { StatusBadge } from '@/components/ui/status-badge';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useCan } from '@/lib/ability';
import { useInstances, useTenants } from '@/lib/queries';

export default function InstancesPage() {
  return (
    <Suspense fallback={<PageSpinner />}>
      <InstancesView />
    </Suspense>
  );
}

const STATUS_FILTERS = ['READY', 'DEGRADED', 'DRAFT', 'DEPLOYING', 'PROVISIONING', 'AWAITING_APPROVAL', 'DEPLOY_FAILED', 'PROVISION_FAILED', 'DESTROYED'];

function InstancesView() {
  const t = useTranslations('instances');
  const fmt = useFormat();
  const statusLabel = useStatusLabel();
  const envLabel = useEnvironmentLabel();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const tenantId = params.get('tenantId') ?? '';
  const status = params.get('status') ?? '';
  const can = useCan();
  const tenants = useTenants();
  const instances = useInstances({ tenantId: tenantId || undefined, status: status || undefined });

  const setFilter = (key: string, value: string) => {
    const sp = new URLSearchParams(params.toString());
    if (value) sp.set(key, value);
    else sp.delete(key);
    router.replace(`${pathname}${sp.toString() ? `?${sp}` : ''}`);
  };

  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          can('create', 'Instance') ? (
            <ButtonLink href="/instances/new" variant="primary">
              <Plus size={14} aria-hidden /> {t('new')}
            </ButtonLink>
          ) : null
        }
      />
      <div className="mb-3 flex flex-wrap items-end gap-2">
        {(tenants.data?.length ?? 0) > 1 ? (
          <div>
            <label htmlFor="filter-tenant" className="mb-1 block text-xs text-fg-subtle">
              {t('filters.tenant')}
            </label>
            <Select id="filter-tenant" value={tenantId} onChange={(e) => setFilter('tenantId', e.target.value)} className="w-52">
              <option value="">{t('filters.allTenants')}</option>
              {tenants.data!.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
        <div>
          <label htmlFor="filter-status" className="mb-1 block text-xs text-fg-subtle">
            {t('filters.status')}
          </label>
          <Select id="filter-status" value={status} onChange={(e) => setFilter('status', e.target.value)} className="w-48">
            <option value="">{t('filters.anyStatus')}</option>
            {[...new Set([...STATUS_FILTERS, ...(status ? [status] : [])])].map((s) => (
              <option key={s} value={s}>
                {statusLabel(s)}
              </option>
            ))}
          </Select>
        </div>
      </div>
      <Card>
        {instances.isPending ? (
          <PageSpinner />
        ) : instances.error ? (
          <ErrorNotice error={instances.error} className="m-4" />
        ) : instances.data.length === 0 ? (
          <EmptyState
            icon={Boxes}
            title={tenantId || status ? t('emptyFilteredTitle') : t('emptyTitle')}
            description={tenantId || status ? t('emptyFilteredBody') : t('emptyBody')}
            action={
              can('create', 'Instance') ? (
                <ButtonLink href="/instances/new" variant="primary">
                  {t('new')}
                </ButtonLink>
              ) : null
            }
          />
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>{t('table.name')}</TH>
                <TH>{t('table.tenant')}</TH>
                <TH>{t('table.template')}</TH>
                <TH>{t('table.environment')}</TH>
                <TH>{t('table.status')}</TH>
                <TH>{t('table.health')}</TH>
                <TH>{t('table.updated')}</TH>
              </tr>
            </THead>
            <TBody>
              {instances.data.map((i) => (
                <TR key={i.id}>
                  <TD>
                    <div className="flex items-center gap-2">
                      <Link href={`/instances/${i.id}`} className="font-medium text-fg hover:text-accent-ink hover:underline">
                        {i.name}
                      </Link>
                      {i.simulated ? <SimulatedBadge /> : null}
                    </div>
                    <code className="font-mono text-[11px] text-fg-subtle">{i.slug}</code>
                  </TD>
                  <TD className="text-fg-muted">{i.tenantName}</TD>
                  <TD className="whitespace-nowrap">
                    {i.template.displayName}
                    <span className="font-mono text-xs text-fg-subtle">@{i.template.version}</span>
                  </TD>
                  <TD className="text-fg-muted">{envLabel(i.environment)}</TD>
                  <TD>
                    <StatusBadge status={i.status} prefix={t('table.status')} />
                  </TD>
                  <TD>
                    <StatusBadge status={i.health} prefix={t('table.health')} />
                  </TD>
                  <TD className="whitespace-nowrap text-xs text-fg-muted">
                    <time dateTime={i.updatedAt}>{fmt.relative(i.updatedAt)}</time>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </>
  );
}
