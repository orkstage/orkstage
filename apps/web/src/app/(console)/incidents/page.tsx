'use client';

import { createIncidentSchema, STATUS_STATES, type CreateIncidentInput, type IncidentDto, type Page } from '@co/contracts';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Siren } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorNotice } from '@/components/ui/error-notice';
import { describedBy, Field, Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { Select } from '@/components/ui/select';
import { PageSpinner } from '@/components/ui/spinner';
import { StatusBadge } from '@/components/ui/status-badge';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { apiGet, apiSend, asItems, qs } from '@/lib/api';
import { useCan, useMe } from '@/lib/ability';
import { tenantNameMap, useInstances, useTenants } from '@/lib/queries';
import { statusLabel } from '@/lib/status';
import { durationBetween, formatDateTime, formatDuration } from '@/lib/utils';

const FILTERS = [
  { id: 'open', label: 'Open' },
  { id: 'RESOLVED', label: 'Resolved' },
  { id: '', label: 'All' },
];

export default function IncidentsPage() {
  const [filter, setFilter] = useState('open');
  const [creating, setCreating] = useState(false);
  const can = useCan();
  const tenants = useTenants();
  const names = tenantNameMap(tenants.data);

  const q = useQuery({
    queryKey: ['incidents', filter],
    queryFn: async ({ signal }) => {
      // "open" is filtered client-side: everything not RESOLVED.
      const items = asItems(await apiGet<IncidentDto[] | Page<IncidentDto>>(`/incidents${qs({ limit: 100, status: filter === 'open' ? undefined : filter })}`, { signal }));
      return filter === 'open' ? items.filter((i) => i.status !== 'RESOLVED') : items;
    },
    refetchInterval: 30_000,
  });

  return (
    <>
      <PageHeader
        title="Incidents"
        description="Disruptions your customers see on their status pages. Health checks open incidents automatically; you can declare one too."
        actions={
          can('create', 'Incident') ? (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus size={14} aria-hidden /> Declare incident
            </Button>
          ) : null
        }
      />
      <div className="mb-3 inline-flex rounded-md border border-border bg-surface p-0.5" role="group" aria-label="Filter incidents">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            aria-pressed={filter === f.id}
            onClick={() => setFilter(f.id)}
            className={`rounded px-3 py-1 text-xs font-medium ${filter === f.id ? 'bg-accent/10 text-accent-ink' : 'text-fg-muted hover:text-fg'}`}
          >
            {f.label}
          </button>
        ))}
      </div>
      <Card>
        {q.isPending ? (
          <PageSpinner />
        ) : q.error ? (
          <ErrorNotice error={q.error} className="m-4" />
        ) : q.data.length === 0 ? (
          <EmptyState icon={Siren} title={filter === 'open' ? 'All quiet on every stage' : 'No incidents'} description={filter === 'open' ? 'No open incidents. Health checks keep watch and open one automatically if something breaks.' : 'Incidents appear here when declared or detected.'} />
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>Incident</TH>
                <TH>Tenant</TH>
                <TH>Status</TH>
                <TH>Impact</TH>
                <TH>Severity</TH>
                <TH>Source</TH>
                <TH>Opened</TH>
                <TH>Duration</TH>
              </tr>
            </THead>
            <TBody>
              {q.data.map((i) => (
                <TR key={i.id}>
                  <TD>
                    <Link href={`/incidents/${i.id}`} className="font-medium hover:text-accent-ink hover:underline">
                      {i.title}
                    </Link>
                  </TD>
                  <TD className="text-fg-muted">{names.get(i.tenantId) ?? '—'}</TD>
                  <TD>
                    <StatusBadge status={i.status} />
                  </TD>
                  <TD>
                    <StatusBadge status={i.impact} />
                  </TD>
                  <TD>
                    <StatusBadge status={i.severity} label={i.severity} />
                  </TD>
                  <TD>
                    <Badge tone={i.source === 'AUTOMATED' ? 'info' : 'neutral'}>{statusLabel(i.source)}</Badge>
                  </TD>
                  <TD className="whitespace-nowrap text-xs text-fg-muted">{formatDateTime(i.openedAt)}</TD>
                  <TD className="whitespace-nowrap text-xs tabular-nums text-fg-muted">{formatDuration(durationBetween(i.openedAt, i.resolvedAt))}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
      <Dialog open={creating} onClose={() => setCreating(false)} title="Declare incident" description="The incident is published on the tenant's status page and notifies subscribers." size="lg">
        <CreateIncidentForm onDone={() => setCreating(false)} />
      </Dialog>
    </>
  );
}

function CreateIncidentForm({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const router = useRouter();
  const me = useMe();
  const tenants = useTenants();
  const tenantOptions = tenants.data?.length
    ? tenants.data.map((t) => ({ id: t.id, name: t.name }))
    : (me.data?.memberships ?? []).map((m) => ({ id: m.tenantId, name: m.tenantName }));

  const form = useForm({
    resolver: zodResolver(createIncidentSchema),
    defaultValues: { tenantId: tenantOptions[0]?.id ?? '', title: '', impact: 'DEGRADED', severity: 'medium', message: '', componentIds: [] } as CreateIncidentInput,
  });
  const { errors } = form.formState;
  const tenantId = form.watch('tenantId');
  const instances = useInstances({ tenantId: tenantId || undefined });

  const create = useMutation({
    mutationFn: (body: CreateIncidentInput) => apiSend<IncidentDto>('POST', '/incidents', body),
    onSuccess: (inc) => {
      void qc.invalidateQueries({ queryKey: ['incidents'] });
      onDone();
      router.push(`/incidents/${inc.id}`);
    },
  });

  return (
    <form onSubmit={form.handleSubmit((v) => create.mutate(v))} className="space-y-4" noValidate>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Tenant" htmlFor="inc-tenant" error={errors.tenantId ? 'Choose a tenant.' : undefined} required>
          <Select id="inc-tenant" {...form.register('tenantId')}>
            <option value="">Select…</option>
            {tenantOptions.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Affected instance" htmlFor="inc-instance" hint="Optional.">
          <Select id="inc-instance" {...form.register('instanceId', { setValueAs: (v: unknown) => (v ? String(v) : undefined) })}>
            <option value="">Whole tenant</option>
            {(instances.data ?? []).map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label="Title" htmlFor="inc-title" error={errors.title?.message} required>
        <Input id="inc-title" placeholder="Elevated API error rates" {...describedBy('inc-title', { error: errors.title })} {...form.register('title')} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Impact" htmlFor="inc-impact" error={errors.impact?.message}>
          <Select id="inc-impact" {...form.register('impact')}>
            {STATUS_STATES.filter((s) => s !== 'UNKNOWN').map((s) => (
              <option key={s} value={s}>
                {statusLabel(s)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Severity" htmlFor="inc-severity" error={errors.severity?.message}>
          <Select id="inc-severity" {...form.register('severity')}>
            {(['low', 'medium', 'high', 'critical'] as const).map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label="First update" htmlFor="inc-message" hint="Shown publicly on the status page. Describe impact, not internal details." error={errors.message?.message} required>
        <Textarea id="inc-message" rows={4} {...describedBy('inc-message', { hint: true, error: errors.message })} {...form.register('message')} />
      </Field>
      {create.error ? <ErrorNotice error={create.error} /> : null}
      <div className="flex justify-end gap-2 border-t border-border pt-3">
        <Button onClick={onDone}>Cancel</Button>
        <Button type="submit" variant="primary" loading={create.isPending}>
          Declare incident
        </Button>
      </div>
    </form>
  );
}
