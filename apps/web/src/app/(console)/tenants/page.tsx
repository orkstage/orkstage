'use client';

import { createTenantSchema, type CreateTenantInput, type TenantDto } from '@co/contracts';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Building2, Plus } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorNotice } from '@/components/ui/error-notice';
import { describedBy, Field, Input } from '@/components/ui/input';
import { Disclosure, PageHeader } from '@/components/ui/page-header';
import { Select } from '@/components/ui/select';
import { PageSpinner } from '@/components/ui/spinner';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { apiSend } from '@/lib/api';
import { useCan } from '@/lib/ability';
import { usePlans, useTenants } from '@/lib/queries';
import { formatDateTime, slugify, splitList } from '@/lib/utils';

export default function TenantsPage() {
  const tenants = useTenants();
  const can = useCan();
  const [creating, setCreating] = useState(false);

  return (
    <>
      <PageHeader
        title="Tenants"
        description="The customers you run stages for: their plan and how many environments they have."
        actions={
          can('create', 'Tenant') ? (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus size={14} aria-hidden /> New tenant
            </Button>
          ) : null
        }
      />
      <Card>
        {tenants.isPending ? (
          <PageSpinner />
        ) : tenants.error ? (
          <ErrorNotice error={tenants.error} className="m-4" />
        ) : tenants.data.length === 0 ? (
          <EmptyState icon={Building2} title="No tenants yet" description="Add your first customer organization, then create instances for it." />
        ) : (
          <TenantTable tenants={tenants.data} />
        )}
      </Card>
      <CreateTenantDialog open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

function TenantTable({ tenants }: { tenants: TenantDto[] }) {
  return (
    <Table>
      <THead>
        <tr>
          <TH>Name</TH>
          <TH>Slug</TH>
          <TH>Plan</TH>
          <TH className="text-right">Instances</TH>
          <TH>Created</TH>
          <TH>
            <span className="sr-only">Links</span>
          </TH>
        </tr>
      </THead>
      <TBody>
        {tenants.map((t) => (
          <TR key={t.id}>
            <TD className="font-medium">{t.name}</TD>
            <TD>
              <code className="font-mono text-xs text-fg-muted">{t.slug}</code>
            </TD>
            <TD>
              <Badge tone="info">{t.plan.name}</Badge>
            </TD>
            <TD className="text-right tabular-nums">{t.instanceCount}</TD>
            <TD className="text-xs text-fg-muted">{formatDateTime(t.createdAt)}</TD>
            <TD className="whitespace-nowrap text-right text-xs">
              <Link href={`/instances?tenantId=${t.id}`} className="text-accent-ink hover:underline">
                Instances
              </Link>
              <span className="mx-1.5 text-fg-subtle">·</span>
              <Link href={`/status/${t.id}`} className="text-accent-ink hover:underline">
                Status page
              </Link>
            </TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}

function CreateTenantDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title="New tenant" description="A tenant is an isolated customer organization with its own plan and instances.">
      <CreateTenantForm onDone={onClose} />
    </Dialog>
  );
}

function CreateTenantForm({ onDone }: { onDone: () => void }) {
  const plans = usePlans();
  const qc = useQueryClient();
  const [slugTouched, setSlugTouched] = useState(false);
  const form = useForm({
    resolver: zodResolver(createTenantSchema),
    defaultValues: { name: '', slug: '', planCode: 'STARTER', allowedEmailDomains: [] } as CreateTenantInput,
  });
  const { errors } = form.formState;

  const create = useMutation({
    mutationFn: (input: CreateTenantInput) => apiSend<TenantDto>('POST', '/tenants', input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tenants'] });
      onDone();
    },
  });

  const nameField = form.register('name', {
    onChange: (e: { target: { value: string } }) => {
      if (!slugTouched) form.setValue('slug', slugify(e.target.value), { shouldValidate: form.formState.isSubmitted });
    },
  });

  return (
    <form onSubmit={form.handleSubmit((v) => create.mutate(v))} className="space-y-4" noValidate>
      <Field label="Name" htmlFor="tenant-name" error={errors.name?.message} required>
        <Input id="tenant-name" autoFocus {...describedBy('tenant-name', { error: errors.name })} {...nameField} />
      </Field>
      <Field label="Slug" htmlFor="tenant-slug" hint="Used in URLs and resource names. Lowercase letters, digits and dashes." error={errors.slug?.message} required>
        <Input
          id="tenant-slug"
          className="font-mono"
          {...describedBy('tenant-slug', { hint: true, error: errors.slug })}
          {...form.register('slug', { onChange: () => setSlugTouched(true) })}
        />
      </Field>
      <Field label="Plan" htmlFor="tenant-plan" error={errors.planCode?.message} hint={plans.isError ? 'Plans could not be loaded.' : undefined} required>
        <Select id="tenant-plan" {...form.register('planCode')}>
          {(plans.data ?? []).length > 0
            ? plans.data!.map((p) => (
                <option key={p.id} value={p.code}>
                  {p.name} ({p.code})
                </option>
              ))
            : ['FREE', 'SANDBOX', 'STARTER', 'GROWTH', 'SCALE'].map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
        </Select>
      </Field>
      <Disclosure summary="Advanced settings">
        <Field label="Allowed email domains" htmlFor="tenant-domains" hint="Comma-separated. Users signing in with SSO from these domains can join this tenant." error={errors.allowedEmailDomains?.message}>
          <Input
            id="tenant-domains"
            placeholder="acme.com, acme.io"
            {...form.register('allowedEmailDomains', { setValueAs: (v: unknown) => splitList(v) })}
          />
        </Field>
      </Disclosure>
      {create.error ? <ErrorNotice error={create.error} /> : null}
      <div className="flex justify-end gap-2 border-t border-border pt-3">
        <Button onClick={onDone}>Cancel</Button>
        <Button type="submit" variant="primary" loading={create.isPending}>
          Create tenant
        </Button>
      </div>
    </form>
  );
}
