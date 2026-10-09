'use client';

import type { OverviewDto } from '@co/contracts';
import { useQuery } from '@tanstack/react-query';
import { Cloud, ScrollText, Users } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import dynamic from 'next/dynamic';
import { useTranslations } from 'use-intl';
import { AuditTable } from '@/components/audit-table';
import { OnboardingChecklist } from '@/components/onboarding-checklist';
import { Card, CardBody, CardHeader, StatCard } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorNotice } from '@/components/ui/error-notice';
import { PageHeader } from '@/components/ui/page-header';
import { PageSpinner } from '@/components/ui/spinner';
import { StatusBadge } from '@/components/ui/status-badge';
import { apiGet } from '@/lib/api';
import { isPlatformStaff, useMe } from '@/lib/ability';
import { useFormat } from '@/i18n/format';
import { toneOf } from '@/lib/status';
import { cn } from '@/lib/utils';

// ECharts is only loaded on pages that chart (kept out of the shared bundle).
const OverviewTrends = dynamic(() => import('@/components/charts/overview-trends'), { ssr: false, loading: () => <TrendsSpinner /> });

function TrendsSpinner() {
  const t = useTranslations('overview');
  return <PageSpinner label={t('loadingTrends')} />;
}

export default function OverviewPage() {
  const t = useTranslations('overview');
  const me = useMe();
  const router = useRouter();
  const staff = isPlatformStaff(me.data);
  const firstTenant = me.data?.memberships[0]?.tenantId;

  useEffect(() => {
    if (me.data && !staff && firstTenant) router.replace(`/status/${firstTenant}`);
  }, [me.data, staff, firstTenant, router]);

  if (!me.data) return <PageSpinner />;
  if (!staff) {
    if (!firstTenant) {
      return <EmptyState icon={Users} title={t('noTenantTitle')} description={t('noTenantBody')} />;
    }
    return <PageSpinner label={t('openingStatus')} />;
  }
  return <PlatformOverview />;
}

function PlatformOverview() {
  const t = useTranslations('overview');
  const fmt = useFormat();
  const q = useQuery({
    queryKey: ['overview'],
    queryFn: ({ signal }) => apiGet<OverviewDto>('/overview', { signal }),
    refetchInterval: 30_000,
  });

  if (q.isPending) return <PageSpinner />;
  if (q.error) return <ErrorNotice error={q.error} title={t('unavailable')} />;
  const o = q.data;

  const statusEntries = Object.entries(o.instancesByStatus).sort((a, b) => b[1] - a[1]);
  const providerEntries = Object.entries(o.providerDistribution).sort((a, b) => b[1] - a[1]);
  const providerTotal = providerEntries.reduce((s, [, n]) => s + n, 0);

  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <OnboardingChecklist instanceCount={o.instances} />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatCard label={t('stats.tenants')} value={fmt.number(o.tenants)} />
        <StatCard label={t('stats.instances')} value={fmt.number(o.instances)} />
        <StatCard label={t('stats.unhealthyResources')} value={fmt.number(o.unhealthyResources)} tone={o.unhealthyResources > 0 ? 'danger' : 'ok'} />
        <StatCard label={t('stats.openIncidents')} value={fmt.number(o.openIncidents)} tone={o.openIncidents > 0 ? 'warn' : undefined} />
        <StatCard
          label={t('stats.deployments24h')}
          value={fmt.number(o.deployments24h.total)}
          hint={<span className={cn(o.deployments24h.failed > 0 && 'text-danger-ink')}>{t('stats.failed', { count: o.deployments24h.failed })}</span>}
        />
        <StatCard label={t('stats.monthlyCost')} value={fmt.money(o.estimatedMonthlyCost)} hint={t('stats.approximate')} />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader title={t('byStatus')} />
          <CardBody>
            {statusEntries.length === 0 ? (
              <p className="text-sm text-fg-subtle">{t('noInstances')}</p>
            ) : (
              <ul className="space-y-1.5">
                {statusEntries.map(([status, n]) => (
                  <li key={status} className="flex items-center justify-between gap-2">
                    <Link href={`/instances?status=${encodeURIComponent(status)}`} className="hover:underline">
                      <StatusBadge status={status} />
                    </Link>
                    <span className="tabular-nums text-fg-muted">{n}</span>
                  </li>
                ))}
              </ul>
            )}
            {providerEntries.length > 0 ? (
              <div className="mt-4 border-t border-border pt-3">
                <p className="mb-2 text-xs font-medium text-fg-subtle">{t('byProvider')}</p>
                <ul className="space-y-1.5">
                  {providerEntries.map(([provider, n]) => (
                    <li key={provider} className="grid grid-cols-[8.5rem_1fr_2.5rem] items-center gap-2 text-xs">
                      <span className="truncate font-mono" title={provider}>
                        {provider}
                      </span>
                      <span className="h-1.5 rounded-full bg-surface-2" aria-hidden>
                        <span className="block h-full rounded-full bg-accent" style={{ width: `${providerTotal ? (n / providerTotal) * 100 : 0}%` }} />
                      </span>
                      <span className="text-right tabular-nums text-fg-muted">{n}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title={t('targetHealth')}
            actions={
              <Link href="/cloud-targets" className="text-xs text-accent-ink hover:underline">
                {t('allTargets')}
              </Link>
            }
          />
          {o.targets.length === 0 ? (
            <EmptyState icon={Cloud} title={t('noTargetsTitle')} description={t('noTargetsBody')} />
          ) : (
            <ul className="divide-y divide-border">
              {o.targets.map((target) => (
                <li key={target.id} className="flex items-center justify-between gap-2 px-4 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{target.name}</p>
                    <p className="font-mono text-[11px] text-fg-subtle">{target.provider}</p>
                  </div>
                  <StatusBadge status={target.health} prefix={t('healthPrefix')} />
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader title={t('attention')} description={t('attentionHint')} />
          <CardBody className="space-y-2 text-sm">
            <AttentionRow label={t('attentionRows.unhealthyResources')} count={o.unhealthyResources} href="/instances" />
            <AttentionRow label={t('attentionRows.openIncidents')} count={o.openIncidents} href="/incidents" />
            <AttentionRow label={t('attentionRows.failedDeployments')} count={o.deployments24h.failed} href="/deployments" />
            <AttentionRow
              label={t('attentionRows.unhealthyTargets')}
              count={o.targets.filter((target) => ['danger', 'warn'].includes(toneOf(target.health))).length}
              href="/cloud-targets"
            />
          </CardBody>
        </Card>
      </div>

      <div className="mt-6">
        <OverviewTrends days={14} />
      </div>

      <Card className="mt-4">
        <CardHeader
          title={t('recentAudit')}
          actions={
            <Link href="/audit" className="text-xs text-accent-ink hover:underline">
              {t('fullAudit')}
            </Link>
          }
        />
        {o.recentAudit.length === 0 ? <EmptyState icon={ScrollText} title={t('noAudit')} /> : <AuditTable events={o.recentAudit} compact />}
      </Card>
    </>
  );
}

function AttentionRow({ label, count, href }: { label: string; count: number; href: string }) {
  const t = useTranslations('overview');
  return (
    <Link href={href} className="flex items-center justify-between rounded-md px-2 py-1.5 hover:bg-surface-2">
      <span className="text-fg-muted">{label}</span>
      <span className={cn('tabular-nums font-semibold', count > 0 ? 'text-danger-ink' : 'text-ok-ink')} aria-label={t('attentionCount', { count })}>
        {count}
      </span>
    </Link>
  );
}
