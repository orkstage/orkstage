'use client';

import { createIncidentSchema, STATUS_STATES, type CreateIncidentInput, type IncidentDto, type Page } from '@co/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Siren } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslations } from 'use-intl';
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
import { useFormat } from '@/i18n/format';
import { useStatusLabel } from '@/i18n/labels';
import { useZodResolver } from '@/i18n/zod';
import { apiGet, apiSend, asItems, qs } from '@/lib/api';
import { useCan, useMe } from '@/lib/ability';
import { tenantNameMap, useInstances, useTenants } from '@/lib/queries';
import { durationBetween } from '@/lib/utils';

const FILTERS = [
  { id: 'open', label: 'open' },
  { id: 'RESOLVED', label: 'resolved' },
  { id: '', label: 'all' },
] as const;

export default function IncidentsPage() {
  const t = useTranslations('incidents');
  const fmt = useFormat();
  const statusLabel = useStatusLabel();
  const [filter, setFilter] = useState<string>('open');
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
        title={t('title')}
        description={t('description')}
        actions={
          can('create', 'Incident') ? (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus size={14} aria-hidden /> {t('declare')}
            </Button>
          ) : null
        }
      />
      <div className="mb-3 inline-flex rounded-md border border-border bg-surface p-0.5" role="group" aria-label={t('filterLabel')}>
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            aria-pressed={filter === f.id}
            onClick={() => setFilter(f.id)}
            className={`rounded px-3 py-1 text-xs font-medium ${filter === f.id ? 'bg-accent/10 text-accent-ink' : 'text-fg-muted hover:text-fg'}`}
          >
            {t(`filters.${f.label}`)}
          </button>
        ))}
      </div>
      <Card>
        {q.isPending ? (
          <PageSpinner />
        ) : q.error ? (
          <ErrorNotice error={q.error} className="m-4" />
        ) : q.data.length === 0 ? (
          <EmptyState
            icon={Siren}
            title={filter === 'open' ? t('emptyOpenTitle') : t('emptyTitle')}
            description={filter === 'open' ? t('emptyOpenBody') : t('emptyBody')}
          />
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>{t('table.incident')}</TH>
                <TH>{t('table.tenant')}</TH>
                <TH>{t('table.status')}</TH>
                <TH>{t('table.impact')}</TH>
                <TH>{t('table.severity')}</TH>
                <TH>{t('table.source')}</TH>
                <TH>{t('table.opened')}</TH>
                <TH>{t('table.duration')}</TH>
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
                  <TD className="text-fg-muted">{names.get(i.tenantId) ?? fmt.empty}</TD>
                  <TD>
                    <StatusBadge status={i.status} />
                  </TD>
                  <TD>
                    <StatusBadge status={i.impact} />
                  </TD>
                  <TD>
                    <StatusBadge status={i.severity} />
                  </TD>
                  <TD>
                    <Badge tone={i.source === 'AUTOMATED' ? 'info' : 'neutral'}>{statusLabel(i.source)}</Badge>
                  </TD>
                  <TD className="whitespace-nowrap text-xs text-fg-muted">{fmt.dateTime(i.openedAt)}</TD>
                  <TD className="whitespace-nowrap text-xs tabular-nums text-fg-muted">{fmt.duration(durationBetween(i.openedAt, i.resolvedAt))}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
      <Dialog open={creating} onClose={() => setCreating(false)} title={t('declare')} description={t('declareDescription')} size="lg">
        <CreateIncidentForm onDone={() => setCreating(false)} />
      </Dialog>
    </>
  );
}

function CreateIncidentForm({ onDone }: { onDone: () => void }) {
  const t = useTranslations('incidents');
  const tc = useTranslations('common');
  const statusLabel = useStatusLabel();
  const qc = useQueryClient();
  const router = useRouter();
  const me = useMe();
  const tenants = useTenants();
  const tenantOptions = tenants.data?.length
    ? tenants.data.map((tenant) => ({ id: tenant.id, name: tenant.name }))
    : (me.data?.memberships ?? []).map((m) => ({ id: m.tenantId, name: m.tenantName }));

  const form = useForm({
    resolver: useZodResolver(createIncidentSchema),
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
        <Field label={t('form.tenant')} htmlFor="inc-tenant" error={errors.tenantId ? t('form.chooseTenant') : undefined} required>
          <Select id="inc-tenant" {...form.register('tenantId')}>
            <option value="">{t('form.select')}</option>
            {tenantOptions.map((tenant) => (
              <option key={tenant.id} value={tenant.id}>
                {tenant.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('form.instance')} htmlFor="inc-instance" hint={t('form.optional')}>
          <Select id="inc-instance" {...form.register('instanceId', { setValueAs: (v: unknown) => (v ? String(v) : undefined) })}>
            <option value="">{t('form.wholeTenant')}</option>
            {(instances.data ?? []).map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label={t('form.title')} htmlFor="inc-title" error={errors.title?.message} required>
        <Input id="inc-title" placeholder={t('form.titlePlaceholder')} {...describedBy('inc-title', { error: errors.title })} {...form.register('title')} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('form.impact')} htmlFor="inc-impact" error={errors.impact?.message}>
          <Select id="inc-impact" {...form.register('impact')}>
            {STATUS_STATES.filter((s) => s !== 'UNKNOWN').map((s) => (
              <option key={s} value={s}>
                {statusLabel(s)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('form.severity')} htmlFor="inc-severity" error={errors.severity?.message}>
          <Select id="inc-severity" {...form.register('severity')}>
            {(['low', 'medium', 'high', 'critical'] as const).map((s) => (
              <option key={s} value={s}>
                {statusLabel(s)}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label={t('form.message')} htmlFor="inc-message" hint={t('form.messageHint')} error={errors.message?.message} required>
        <Textarea id="inc-message" rows={4} {...describedBy('inc-message', { hint: true, error: errors.message })} {...form.register('message')} />
      </Field>
      {create.error ? <ErrorNotice error={create.error} /> : null}
      <div className="flex justify-end gap-2 border-t border-border pt-3">
        <Button onClick={onDone}>{tc('cancel')}</Button>
        <Button type="submit" variant="primary" loading={create.isPending}>
          {t('declare')}
        </Button>
      </div>
    </form>
  );
}
