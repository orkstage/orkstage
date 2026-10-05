'use client';

import type { OverviewDto } from '@co/contracts';
import { useQuery } from '@tanstack/react-query';
import { Cloud, ScrollText, Users } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import dynamic from 'next/dynamic';
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
import { statusLabel, toneOf } from '@/lib/status';
import { cn, formatMoney } from '@/lib/utils';

// ECharts is only loaded on pages that chart (kept out of the shared bundle).
const OverviewTrends = dynamic(() => import('@/components/charts/overview-trends'), { ssr: false, loading: () => <PageSpinner label="Loading trends" /> });

export default function OverviewPage() {
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
      return <EmptyState icon={Users} title="No tenant access yet" description="Ask your organization administrator to add you to a tenant." />;
    }
    return <PageSpinner label="Opening your status page" />;
  }
  return <PlatformOverview />;
}

function PlatformOverview() {
  const q = useQuery({
    queryKey: ['overview'],
    queryFn: ({ signal }) => apiGet<OverviewDto>('/overview', { signal }),
    refetchInterval: 30_000,
  });

  if (q.isPending) return <PageSpinner />;
  if (q.error) return <ErrorNotice error={q.error} title="Overview unavailable" />;
  const o = q.data;

  const statusEntries = Object.entries(o.instancesByStatus).sort((a, b) => b[1] - a[1]);
  const providerEntries = Object.entries(o.providerDistribution).sort((a, b) => b[1] - a[1]);
  const providerTotal = providerEntries.reduce((s, [, n]) => s + n, 0);

  return (
    <>
      <PageHeader title="Overview" description="Your fleet at a glance: health, deployments and spend across every cloud." />
      <OnboardingChecklist instanceCount={o.instances} />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatCard label="Tenants" value={o.tenants} />
        <StatCard label="Instances" value={o.instances} />
        <StatCard label="Unhealthy resources" value={o.unhealthyResources} tone={o.unhealthyResources > 0 ? 'danger' : 'ok'} />
        <StatCard label="Open incidents" value={o.openIncidents} tone={o.openIncidents > 0 ? 'warn' : undefined} />
        <StatCard
          label="Deployments (24h)"
          value={o.deployments24h.total}
          hint={<span className={cn(o.deployments24h.failed > 0 && 'text-danger-ink')}>{o.deployments24h.failed} failed</span>}
        />
        <StatCard label="Est. monthly cost" value={formatMoney(o.estimatedMonthlyCost)} hint="Approximate — not an invoice" />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader title="Instances by status" />
          <CardBody>
            {statusEntries.length === 0 ? (
              <p className="text-sm text-fg-subtle">No instances yet.</p>
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
                <p className="mb-2 text-xs font-medium text-fg-subtle">Resources by provider</p>
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
          <CardHeader title="Cloud target health" actions={<Link href="/cloud-targets" className="text-xs text-accent-ink hover:underline">All targets</Link>} />
          {o.targets.length === 0 ? (
            <EmptyState icon={Cloud} title="No cloud targets connected" description="Connect a cloud account, or register a mock target, before your first deploy." />
          ) : (
            <ul className="divide-y divide-border">
              {o.targets.map((t) => (
                <li key={t.id} className="flex items-center justify-between gap-2 px-4 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{t.name}</p>
                    <p className="font-mono text-[11px] text-fg-subtle">{t.provider}</p>
                  </div>
                  <StatusBadge status={t.health} prefix="Health" />
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader title="Attention" description="What needs an operator right now." />
          <CardBody className="space-y-2 text-sm">
            <AttentionRow label="Unhealthy resources" count={o.unhealthyResources} href="/instances" />
            <AttentionRow label="Open incidents" count={o.openIncidents} href="/incidents" />
            <AttentionRow label="Failed deployments (24h)" count={o.deployments24h.failed} href="/deployments" />
            <AttentionRow
              label="Unhealthy cloud targets"
              count={o.targets.filter((t) => ['danger', 'warn'].includes(toneOf(t.health))).length}
              href="/cloud-targets"
            />
          </CardBody>
        </Card>
      </div>

      <div className="mt-6">
        <OverviewTrends days={14} />
      </div>

      <Card className="mt-4">
        <CardHeader title="Recent audit events" actions={<Link href="/audit" className="text-xs text-accent-ink hover:underline">Full audit log</Link>} />
        {o.recentAudit.length === 0 ? <EmptyState icon={ScrollText} title="No audit events yet" /> : <AuditTable events={o.recentAudit} compact />}
      </Card>
    </>
  );
}

function AttentionRow({ label, count, href }: { label: string; count: number; href: string }) {
  return (
    <Link href={href} className="flex items-center justify-between rounded-md px-2 py-1.5 hover:bg-surface-2">
      <span className="text-fg-muted">{label}</span>
      <span className={cn('tabular-nums font-semibold', count > 0 ? 'text-danger-ink' : 'text-ok-ink')} aria-label={`${count} (${count > 0 ? statusLabel('UNHEALTHY') : 'ok'})`}>
        {count}
      </span>
    </Link>
  );
}
