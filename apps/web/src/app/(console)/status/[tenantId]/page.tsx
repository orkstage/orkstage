'use client';

import type { IncidentDto, StatusPageDto } from '@co/contracts';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, HelpCircle, OctagonAlert, Wrench, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'use-intl';
import { SimulatedBadge } from '@/components/ui/badge';
import { Card, CardHeader } from '@/components/ui/card';
import { ErrorNotice } from '@/components/ui/error-notice';
import { Select } from '@/components/ui/select';
import { PageSpinner, Spinner } from '@/components/ui/spinner';
import { StatusBadge, StatusDot } from '@/components/ui/status-badge';
import { useFormat } from '@/i18n/format';
import { useStatusLabel } from '@/i18n/labels';
import { apiGet } from '@/lib/api';
import { isPlatformStaff, useMe } from '@/lib/ability';
import { useTenants } from '@/lib/queries';
import { toneOf, type Tone } from '@/lib/status';
import { cn, durationBetween } from '@/lib/utils';

const HEADLINES = ['OPERATIONAL', 'DEGRADED', 'PARTIAL_OUTAGE', 'MAJOR_OUTAGE', 'MAINTENANCE', 'UNKNOWN'] as const;
type Headline = (typeof HEADLINES)[number];

const BANNER: Record<Tone, { icon: LucideIcon; box: string; icon_: string }> = {
  ok: { icon: CheckCircle2, box: 'border-ok/40 bg-ok/8', icon_: 'text-ok-ink' },
  warn: { icon: AlertTriangle, box: 'border-warn/45 bg-warn/10', icon_: 'text-warn-ink' },
  danger: { icon: OctagonAlert, box: 'border-danger/45 bg-danger/8', icon_: 'text-danger-ink' },
  info: { icon: Wrench, box: 'border-info/40 bg-info/8', icon_: 'text-info-ink' },
  neutral: { icon: HelpCircle, box: 'border-border bg-surface', icon_: 'text-fg-subtle' },
  accent: { icon: HelpCircle, box: 'border-border bg-surface', icon_: 'text-fg-subtle' },
};

const STATUS_TEXT: Record<Tone, string> = {
  ok: 'text-ok-ink',
  warn: 'text-warn-ink',
  danger: 'text-danger-ink',
  info: 'text-info-ink',
  neutral: 'text-fg-subtle',
  accent: 'text-accent-ink',
};

function latestUpdate(i: IncidentDto) {
  return [...(i.updates ?? [])].sort((a, b) => b.at.localeCompare(a.at))[0] ?? null;
}

export default function StatusPage() {
  const t = useTranslations('statusPage');
  const fmt = useFormat();
  const statusLabel = useStatusLabel();
  const { tenantId } = useParams<{ tenantId: string }>();
  const router = useRouter();
  const me = useMe();
  const staff = isPlatformStaff(me.data);
  const tenants = useTenants(staff);
  const switchable = staff
    ? (tenants.data ?? []).map((tenant) => ({ id: tenant.id, name: tenant.name }))
    : (me.data?.memberships ?? []).map((m) => ({ id: m.tenantId, name: m.tenantName }));

  const q = useQuery({
    queryKey: ['status', tenantId],
    queryFn: ({ signal }) => apiGet<StatusPageDto>(`/status/${tenantId}`, { signal }),
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });

  if (q.isPending) return <PageSpinner />;
  if (q.error) return <ErrorNotice error={q.error} title={t('unavailable')} />;
  const s = q.data;
  const tone = toneOf(s.overall);
  const banner = BANNER[tone];
  const Icon = banner.icon;
  const recent = s.recentIncidents.filter((i) => !s.openIncidents.some((o) => o.id === i.id));
  const overall = s.overall.toUpperCase();
  const headline: Headline = (HEADLINES as readonly string[]).includes(overall) ? (overall as Headline) : 'UNKNOWN';

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-fg-subtle">{t('eyebrow')}</p>
          <h1 className="text-xl font-semibold tracking-tight">{s.tenant.name}</h1>
        </div>
        {switchable.length > 1 ? (
          <div>
            <label htmlFor="status-tenant" className="mb-1 block text-xs text-fg-subtle">
              {t('tenant')}
            </label>
            <Select id="status-tenant" value={tenantId} onChange={(e) => router.push(`/status/${e.target.value}`)} className="w-56">
              {switchable.map((tenant) => (
                <option key={tenant.id} value={tenant.id}>
                  {tenant.name}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
      </div>

      <section aria-live="polite" className={cn('flex items-center gap-4 rounded-lg border px-5 py-5', banner.box)}>
        <Icon size={32} className={cn('shrink-0', banner.icon_)} aria-hidden />
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold">{t(`headline.${headline}`)}</h2>
          <p className="text-xs text-fg-subtle">{t('updated', { time: fmt.time(new Date(q.dataUpdatedAt).toISOString()) })}</p>
        </div>
        {q.isFetching ? <Spinner size={14} className="text-fg-subtle" label={t('refreshing')} /> : null}
      </section>

      {s.openIncidents.length > 0 ? (
        <section aria-labelledby="open-inc" className="space-y-3">
          <h2 id="open-inc" className="text-sm font-semibold">
            {t('active')}
          </h2>
          {s.openIncidents.map((i) => {
            const u = latestUpdate(i);
            const tone = toneOf(i.impact);
            return (
              <article key={i.id} className={cn('rounded-lg border bg-surface p-4 shadow-card', tone === 'danger' ? 'border-danger/40' : tone === 'warn' ? 'border-warn/40' : 'border-border')}>
                <div className="flex flex-wrap items-center gap-2">
                  <Link href={`/incidents/${i.id}`} className={cn('font-semibold hover:underline', STATUS_TEXT[tone])}>
                    {i.title}
                  </Link>
                  <StatusBadge status={i.status} />
                  <span className="text-xs text-fg-subtle">{t('since', { date: fmt.dateTime(i.openedAt) })}</span>
                </div>
                {u ? (
                  <p className="mt-2 text-sm">
                    <strong className="font-medium">{statusLabel(u.status)}:</strong> {u.message}
                    <span className="ml-1 text-xs text-fg-subtle">({fmt.relative(u.at)})</span>
                  </p>
                ) : null}
              </article>
            );
          })}
        </section>
      ) : null}

      <section aria-labelledby="components" className="space-y-3">
        <h2 id="components" className="text-sm font-semibold">
          {t('components')}
        </h2>
        {s.instances.length === 0 ? (
          <Card className="px-4 py-6 text-center text-sm text-fg-subtle">{t('noInstances')}</Card>
        ) : (
          s.instances.map((inst) => {
            const tone = toneOf(inst.status);
            return (
              <Card key={inst.id}>
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
                  <div className="flex items-center gap-2">
                    <StatusDot status={inst.status} className="h-2.5 w-2.5" />
                    <h3 className="font-medium">{inst.name}</h3>
                    {inst.simulated ? <SimulatedBadge /> : null}
                  </div>
                  <span className={cn('text-sm font-medium', STATUS_TEXT[tone])}>{statusLabel(inst.status)}</span>
                </div>
                {inst.components.length > 0 ? (
                  <ul className="divide-y divide-border">
                    {inst.components.map((c) => (
                      <li key={c.id} className="flex items-center justify-between gap-2 px-4 py-2 text-sm">
                        <span className="flex items-center gap-2">
                          <StatusDot status={c.status} />
                          {c.name}
                        </span>
                        <span className={cn('text-xs', STATUS_TEXT[toneOf(c.status)])}>{statusLabel(c.status)}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </Card>
            );
          })
        )}
      </section>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader title={t('past')} as="h2" />
          {recent.length === 0 ? (
            <p className="px-4 py-4 text-sm text-fg-subtle">{t('noPast')}</p>
          ) : (
            <ul className="divide-y divide-border">
              {recent.map((i) => (
                <li key={i.id} className="px-4 py-2.5">
                  <Link href={`/incidents/${i.id}`} className="text-sm font-medium hover:text-accent-ink hover:underline">
                    {i.title}
                  </Link>
                  <p className="text-xs text-fg-subtle">
                    {fmt.dateTime(i.openedAt)}
                    {' · '}
                    {i.resolvedAt ? t('resolvedAfter', { duration: fmt.duration(durationBetween(i.openedAt, i.resolvedAt)) }) : statusLabel(i.status)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <CardHeader title={t('activity')} as="h2" />
          {s.recentActivity.length === 0 ? (
            <p className="px-4 py-4 text-sm text-fg-subtle">{t('noActivity')}</p>
          ) : (
            <ul className="divide-y divide-border">
              {s.recentActivity.map((a, i) => (
                <li key={`${a.at}-${i}`} className="flex gap-3 px-4 py-2 text-sm">
                  <time dateTime={a.at} className="w-20 shrink-0 text-xs text-fg-subtle" title={fmt.dateTime(a.at)}>
                    {fmt.relative(a.at)}
                  </time>
                  <span className="min-w-0 flex-1">{a.message}</span>
                  <span className="shrink-0 font-mono text-[10px] text-fg-subtle">{a.kind}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
