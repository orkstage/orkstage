'use client';

import { INCIDENT_STATUSES, incidentUpdateSchema, STATUS_STATES, type IncidentDto, type IncidentUpdateInput } from '@co/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { useTranslations } from 'use-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { ErrorNotice } from '@/components/ui/error-notice';
import { describedBy, Field } from '@/components/ui/input';
import { KeyValues, PageHeader } from '@/components/ui/page-header';
import { Select } from '@/components/ui/select';
import { PageSpinner } from '@/components/ui/spinner';
import { StatusBadge, StatusDot } from '@/components/ui/status-badge';
import { Textarea } from '@/components/ui/textarea';
import { useFormat } from '@/i18n/format';
import { useStatusLabel } from '@/i18n/labels';
import { useZodResolver } from '@/i18n/zod';
import { apiGet, apiSend } from '@/lib/api';
import { useCan } from '@/lib/ability';
import { useDocumentTitle } from '@/lib/hooks';
import { durationBetween } from '@/lib/utils';

export default function IncidentPage() {
  const t = useTranslations('incidents.detail');
  const fmt = useFormat();
  const statusLabel = useStatusLabel();
  const { id } = useParams<{ id: string }>();
  const can = useCan();
  const q = useQuery({
    queryKey: ['incident', id],
    queryFn: ({ signal }) => apiGet<IncidentDto>(`/incidents/${id}`, { signal }),
    refetchInterval: 30_000,
  });
  useDocumentTitle(q.data?.title);

  if (q.isPending) return <PageSpinner />;
  if (q.error) return <ErrorNotice error={q.error} title={t('unavailable')} />;
  const inc = q.data;
  const updates = [...(inc.updates ?? [])].sort((a, b) => b.at.localeCompare(a.at));
  const canUpdate = can('update', 'Incident', inc.tenantId) && inc.status !== 'RESOLVED';

  return (
    <>
      <PageHeader
        breadcrumb={
          <Link href="/incidents" className="hover:underline">
            {t('breadcrumb')}
          </Link>
        }
        title={inc.title}
        meta={
          <>
            <StatusBadge status={inc.status} />
            <StatusBadge status={inc.impact} prefix={t('impactPrefix')} />
            <StatusBadge status={inc.severity} label={t('severity', { severity: statusLabel(inc.severity).toLowerCase() })} />
            <Badge tone={inc.source === 'AUTOMATED' ? 'info' : 'neutral'}>{statusLabel(inc.source)}</Badge>
          </>
        }
      />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-4">
          {canUpdate ? <AddUpdateForm incident={inc} /> : null}
          <Card>
            <CardHeader title={t('timeline')} description={t('timelineHint')} />
            <CardBody>
              {updates.length === 0 ? (
                <p className="text-sm text-fg-subtle">{t('noUpdates')}</p>
              ) : (
                <ol className="relative space-y-5 border-l border-border pl-5">
                  {updates.map((u) => (
                    <li key={u.id} className="relative">
                      <span className="absolute -left-[1.6rem] top-1 flex h-3 w-3 items-center justify-center rounded-full bg-surface ring-2 ring-surface">
                        <StatusDot status={u.status} className="h-2.5 w-2.5" />
                      </span>
                      <div className="flex flex-wrap items-center gap-2">
                        <StatusBadge status={u.status} />
                        <time dateTime={u.at} className="text-xs text-fg-subtle" title={fmt.dateTime(u.at)}>
                          {fmt.dateTime(u.at)} · {fmt.relative(u.at)}
                        </time>
                      </div>
                      <p className="mt-1 whitespace-pre-wrap text-sm">{u.message}</p>
                    </li>
                  ))}
                </ol>
              )}
            </CardBody>
          </Card>
        </div>
        <Card className="self-start">
          <CardHeader title={t('details')} as="h3" />
          <CardBody>
            <KeyValues
              items={[
                { label: t('opened'), value: fmt.dateTime(inc.openedAt) },
                { label: t('resolved'), value: fmt.dateTime(inc.resolvedAt) },
                { label: t('duration'), value: fmt.duration(durationBetween(inc.openedAt, inc.resolvedAt)) },
                {
                  label: t('statusPage'),
                  value: (
                    <Link href={`/status/${inc.tenantId}`} className="text-accent-ink hover:underline">
                      {t('open')}
                    </Link>
                  ),
                },
                ...(inc.instanceId
                  ? [
                      {
                        label: t('instance'),
                        value: (
                          <Link href={`/instances/${inc.instanceId}`} className="text-accent-ink hover:underline">
                            {t('viewInstance')}
                          </Link>
                        ),
                      },
                    ]
                  : []),
              ]}
            />
          </CardBody>
        </Card>
      </div>
    </>
  );
}

function AddUpdateForm({ incident }: { incident: IncidentDto }) {
  const t = useTranslations('incidents.detail');
  const statusLabel = useStatusLabel();
  const qc = useQueryClient();
  const form = useForm({
    resolver: useZodResolver(incidentUpdateSchema),
    defaultValues: { status: incident.status, message: '', impact: undefined } as IncidentUpdateInput,
  });
  const { errors } = form.formState;
  const add = useMutation({
    mutationFn: (body: IncidentUpdateInput) => apiSend('POST', `/incidents/${incident.id}/updates`, body),
    onSuccess: () => {
      form.reset({ status: form.getValues('status'), message: '', impact: undefined });
      void qc.invalidateQueries({ queryKey: ['incident', incident.id] });
      void qc.invalidateQueries({ queryKey: ['incidents'] });
    },
  });
  return (
    <Card>
      <CardHeader title={t('postUpdate')} />
      <CardBody>
        <form onSubmit={form.handleSubmit((v) => add.mutate(v))} className="space-y-3" noValidate>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('status')} htmlFor="upd-status" error={errors.status?.message}>
              <Select id="upd-status" {...form.register('status')}>
                {INCIDENT_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {statusLabel(s)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('impact')} htmlFor="upd-impact" hint={t('impactHint')}>
              <Select id="upd-impact" {...form.register('impact', { setValueAs: (v: unknown) => (v ? String(v) : undefined) })}>
                <option value="">{t('unchanged', { impact: statusLabel(incident.impact) })}</option>
                {STATUS_STATES.map((s) => (
                  <option key={s} value={s}>
                    {statusLabel(s)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label={t('message')} htmlFor="upd-message" error={errors.message?.message} required>
            <Textarea id="upd-message" rows={3} {...describedBy('upd-message', { error: errors.message })} {...form.register('message')} />
          </Field>
          {add.error ? <ErrorNotice error={add.error} /> : null}
          <div className="flex justify-end">
            <Button type="submit" variant="primary" loading={add.isPending}>
              {t('submit')}
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}
