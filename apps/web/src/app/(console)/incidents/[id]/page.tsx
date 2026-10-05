'use client';

import { INCIDENT_STATUSES, incidentUpdateSchema, STATUS_STATES, type IncidentDto, type IncidentUpdateInput } from '@co/contracts';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useForm } from 'react-hook-form';
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
import { apiGet, apiSend } from '@/lib/api';
import { useCan } from '@/lib/ability';
import { statusLabel } from '@/lib/status';
import { durationBetween, formatDateTime, formatDuration, formatRelative } from '@/lib/utils';

export default function IncidentPage() {
  const { id } = useParams<{ id: string }>();
  const can = useCan();
  const q = useQuery({
    queryKey: ['incident', id],
    queryFn: ({ signal }) => apiGet<IncidentDto>(`/incidents/${id}`, { signal }),
    refetchInterval: 30_000,
  });

  if (q.isPending) return <PageSpinner />;
  if (q.error) return <ErrorNotice error={q.error} title="Incident unavailable" />;
  const inc = q.data;
  const updates = [...(inc.updates ?? [])].sort((a, b) => b.at.localeCompare(a.at));
  const canUpdate = can('update', 'Incident', inc.tenantId) && inc.status !== 'RESOLVED';

  return (
    <>
      <PageHeader
        breadcrumb={
          <Link href="/incidents" className="hover:underline">
            Incidents
          </Link>
        }
        title={inc.title}
        meta={
          <>
            <StatusBadge status={inc.status} />
            <StatusBadge status={inc.impact} prefix="Impact" />
            <StatusBadge status={inc.severity} label={`severity ${inc.severity}`} />
            <Badge tone={inc.source === 'AUTOMATED' ? 'info' : 'neutral'}>{statusLabel(inc.source)}</Badge>
          </>
        }
      />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-4">
          {canUpdate ? <AddUpdateForm incident={inc} /> : null}
          <Card>
            <CardHeader title="Timeline" description="Newest first. Updates are visible on the tenant status page." />
            <CardBody>
              {updates.length === 0 ? (
                <p className="text-sm text-fg-subtle">No updates yet.</p>
              ) : (
                <ol className="relative space-y-5 border-l border-border pl-5">
                  {updates.map((u) => (
                    <li key={u.id} className="relative">
                      <span className="absolute -left-[1.6rem] top-1 flex h-3 w-3 items-center justify-center rounded-full bg-surface ring-2 ring-surface">
                        <StatusDot status={u.status} className="h-2.5 w-2.5" />
                      </span>
                      <div className="flex flex-wrap items-center gap-2">
                        <StatusBadge status={u.status} />
                        <time dateTime={u.at} className="text-xs text-fg-subtle" title={formatDateTime(u.at)}>
                          {formatDateTime(u.at)} · {formatRelative(u.at)}
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
          <CardHeader title="Details" as="h3" />
          <CardBody>
            <KeyValues
              items={[
                { label: 'Opened', value: formatDateTime(inc.openedAt) },
                { label: 'Resolved', value: formatDateTime(inc.resolvedAt) },
                { label: 'Duration', value: formatDuration(durationBetween(inc.openedAt, inc.resolvedAt)) },
                { label: 'Status page', value: <Link href={`/status/${inc.tenantId}`} className="text-accent-ink hover:underline">Open</Link> },
                ...(inc.instanceId ? [{ label: 'Instance', value: <Link href={`/instances/${inc.instanceId}`} className="text-accent-ink hover:underline">View instance</Link> }] : []),
              ]}
            />
          </CardBody>
        </Card>
      </div>
    </>
  );
}

function AddUpdateForm({ incident }: { incident: IncidentDto }) {
  const qc = useQueryClient();
  const form = useForm({
    resolver: zodResolver(incidentUpdateSchema),
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
      <CardHeader title="Post an update" />
      <CardBody>
        <form onSubmit={form.handleSubmit((v) => add.mutate(v))} className="space-y-3" noValidate>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Status" htmlFor="upd-status" error={errors.status?.message}>
              <Select id="upd-status" {...form.register('status')}>
                {INCIDENT_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {statusLabel(s)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Impact" htmlFor="upd-impact" hint="Leave unchanged to keep the current impact.">
              <Select id="upd-impact" {...form.register('impact', { setValueAs: (v: unknown) => (v ? String(v) : undefined) })}>
                <option value="">Unchanged ({statusLabel(incident.impact)})</option>
                {STATUS_STATES.map((s) => (
                  <option key={s} value={s}>
                    {statusLabel(s)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="Message" htmlFor="upd-message" error={errors.message?.message} required>
            <Textarea id="upd-message" rows={3} {...describedBy('upd-message', { error: errors.message })} {...form.register('message')} />
          </Field>
          {add.error ? <ErrorNotice error={add.error} /> : null}
          <div className="flex justify-end">
            <Button type="submit" variant="primary" loading={add.isPending}>
              Post update
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}
