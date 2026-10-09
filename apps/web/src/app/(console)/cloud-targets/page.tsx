'use client';

import { createCloudTargetSchema, PROVIDERS, SECRET_REF_PATTERN, type CapabilityDto, type CloudTargetDto, type Page } from '@co/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Cloud, ListChecks, Plus, ShieldCheck } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslations } from 'use-intl';
import { z } from 'zod';
import { Badge, SimulatedBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorNotice, Notice } from '@/components/ui/error-notice';
import { describedBy, Field, Input } from '@/components/ui/input';
import { Disclosure, PageHeader } from '@/components/ui/page-header';
import { Select } from '@/components/ui/select';
import { PageSpinner } from '@/components/ui/spinner';
import { StatusBadge } from '@/components/ui/status-badge';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { useFormat } from '@/i18n/format';
import { useEnvironmentLabel, useStatusLabel } from '@/i18n/labels';
import { useZodResolver } from '@/i18n/zod';
import { apiGet, apiSend, asItems } from '@/lib/api';
import { useCan } from '@/lib/ability';
import { tenantNameMap, useCloudTargets, useTenants } from '@/lib/queries';
import { looksLikeSecretKey, splitList } from '@/lib/utils';

type Validation = NonNullable<CloudTargetDto['lastValidation']>;

export default function CloudTargetsPage() {
  const t = useTranslations('cloudTargets');
  const fmt = useFormat();
  const envLabel = useEnvironmentLabel();
  const targets = useCloudTargets();
  const tenants = useTenants();
  const can = useCan();
  const [registering, setRegistering] = useState(false);
  const [validating, setValidating] = useState<CloudTargetDto | null>(null);
  const [capabilities, setCapabilities] = useState<CloudTargetDto | null>(null);
  const tenantNames = tenantNameMap(tenants.data);
  const canValidate = can('update', 'CloudTarget');

  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          can('create', 'CloudTarget') ? (
            <Button variant="primary" onClick={() => setRegistering(true)}>
              <Plus size={14} aria-hidden /> {t('register')}
            </Button>
          ) : null
        }
      />
      <Card>
        {targets.isPending ? (
          <PageSpinner />
        ) : targets.error ? (
          <ErrorNotice error={targets.error} className="m-4" />
        ) : targets.data.length === 0 ? (
          <EmptyState icon={Cloud} title={t('emptyTitle')} description={t('emptyBody')} />
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>{t('table.target')}</TH>
                <TH>{t('table.provider')}</TH>
                <TH>{t('table.regions')}</TH>
                <TH>{t('table.health')}</TH>
                <TH>{t('table.status')}</TH>
                <TH>{t('table.lastValidation')}</TH>
                <TH>
                  <span className="sr-only">{t('table.actions')}</span>
                </TH>
              </tr>
            </THead>
            <TBody>
              {targets.data.map((target) => (
                <TR key={target.id}>
                  <TD>
                    <p className="font-medium">{target.name}</p>
                    <p className="text-[11px] text-fg-subtle">
                      {envLabel(target.environment)} · {target.tenantId ? (tenantNames.get(target.tenantId) ?? t('tenantScoped')) : t('shared')}
                      {target.hasCredentialRef ? ` · ${t('credentialSet')}` : ''}
                    </p>
                  </TD>
                  <TD>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <code className="font-mono text-xs">{target.provider}</code>
                      {target.simulated ? <SimulatedBadge simulates={target.simulates} /> : null}
                    </div>
                  </TD>
                  <TD className="max-w-56">
                    <div className="flex flex-wrap gap-1">
                      {target.allowedRegions.map((r) => (
                        <Badge key={r} tone={r === target.defaultRegion ? 'info' : 'neutral'} title={r === target.defaultRegion ? t('defaultRegion') : undefined}>
                          {r}
                        </Badge>
                      ))}
                    </div>
                  </TD>
                  <TD>
                    <StatusBadge status={target.health} prefix={t('table.health')} />
                  </TD>
                  <TD>
                    <StatusBadge status={target.status} />
                  </TD>
                  <TD className="whitespace-nowrap text-xs">
                    {target.lastValidation ? (
                      <span className="flex items-center gap-1.5">
                        <StatusBadge status={target.lastValidation.ok ? 'PASS' : 'FAIL'} label={target.lastValidation.ok ? t('passed') : t('failed')} />
                        <span className="text-fg-subtle" title={fmt.dateTime(target.lastValidation.validatedAt)}>
                          {fmt.relative(target.lastValidation.validatedAt)}
                        </span>
                      </span>
                    ) : (
                      <span className="text-fg-subtle">{t('never')}</span>
                    )}
                  </TD>
                  <TD className="whitespace-nowrap text-right">
                    <div className="flex justify-end gap-1.5">
                      {canValidate ? (
                        <Button size="sm" onClick={() => setValidating(target)}>
                          <ShieldCheck size={13} aria-hidden /> {t('validate')}
                        </Button>
                      ) : null}
                      <Button size="sm" variant="ghost" onClick={() => setCapabilities(target)}>
                        <ListChecks size={13} aria-hidden /> {t('capabilities')}
                      </Button>
                    </div>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      <Dialog open={registering} onClose={() => setRegistering(false)} title={t('registerTitle')} description={t('registerDescription')} size="lg">
        <RegisterForm onDone={() => setRegistering(false)} />
      </Dialog>
      <Dialog open={!!validating} onClose={() => setValidating(null)} title={t('validateTitle', { name: validating?.name ?? '' })} description={t('validateDescription')}>
        {validating ? <ValidatePanel target={validating} /> : null}
      </Dialog>
      <Dialog
        open={!!capabilities}
        onClose={() => setCapabilities(null)}
        variant="drawer"
        title={t('capabilitiesTitle', { name: capabilities?.name ?? '' })}
        description={t('capabilitiesDescription')}
      >
        {capabilities ? <CapabilitiesPanel target={capabilities} /> : null}
      </Dialog>
    </>
  );
}

function ChecksList({ validation }: { validation: Validation }) {
  const t = useTranslations('cloudTargets');
  const fmt = useFormat();
  const statusLabel = useStatusLabel();
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <StatusBadge status={validation.ok ? 'PASS' : 'FAIL'} label={validation.ok ? t('allPassed') : t('validationFailed')} />
        <span className="text-xs text-fg-subtle">{fmt.dateTime(validation.validatedAt)}</span>
        {validation.identity ? <code className="font-mono text-xs text-fg-muted">{validation.identity}</code> : null}
      </div>
      <ul className="divide-y divide-border rounded-md border border-border">
        {validation.checks.map((c, i) => (
          <li key={`${c.name}-${i}`} className="flex items-start gap-2 px-3 py-2">
            <StatusBadge status={c.status} label={statusLabel(c.status)} className="mt-0.5 min-w-16 justify-center" />
            <div className="min-w-0 text-sm">
              <p className="font-medium">{c.name}</p>
              <p className="text-xs text-fg-muted">{c.message}</p>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ValidatePanel({ target }: { target: CloudTargetDto }) {
  const t = useTranslations('cloudTargets');
  const qc = useQueryClient();
  const [region, setRegion] = useState('');
  const validate = useMutation({
    mutationFn: async () => {
      const res = await apiSend<Validation | CloudTargetDto>('POST', `/cloud/targets/${target.id}/validate`, region ? { region } : {});
      // Accept either the validation report or the updated target.
      return 'checks' in res ? res : res.lastValidation;
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['cloud-targets'] }),
  });
  const shown = validate.data ?? (validate.isIdle ? target.lastValidation : null);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <label htmlFor="validate-region" className="mb-1 block text-xs text-fg-subtle">
            {t('region')}
          </label>
          <Select id="validate-region" value={region} onChange={(e) => setRegion(e.target.value)} className="w-48">
            <option value="">{t('defaultOption', { region: target.defaultRegion })}</option>
            {target.allowedRegions.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </Select>
        </div>
        <Button variant="primary" onClick={() => validate.mutate()} loading={validate.isPending}>
          {t('runValidation')}
        </Button>
      </div>
      {validate.error ? <ErrorNotice error={validate.error} /> : null}
      {shown ? (
        <>
          {validate.isIdle ? <p className="text-xs text-fg-subtle">{t('lastStored')}</p> : null}
          <ChecksList validation={shown} />
        </>
      ) : validate.isIdle ? (
        <p className="text-sm text-fg-subtle">{t('neverValidated')}</p>
      ) : null}
    </div>
  );
}

function CapabilitiesPanel({ target }: { target: CloudTargetDto }) {
  const t = useTranslations('cloudTargets');
  const q = useQuery({
    queryKey: ['capabilities', target.id],
    queryFn: async ({ signal }) => asItems(await apiGet<CapabilityDto[] | Page<CapabilityDto>>(`/cloud/targets/${target.id}/capabilities`, { signal })),
  });
  if (q.isPending) return <PageSpinner />;
  if (q.error) return <ErrorNotice error={q.error} />;
  const byKind = new Map<string, CapabilityDto[]>();
  for (const c of q.data) byKind.set(c.serviceKind, [...(byKind.get(c.serviceKind) ?? []), c]);
  if (byKind.size === 0) return <EmptyState title={t('noCapabilities')} />;
  return (
    <div className="space-y-4">
      {target.simulated ? (
        <Notice tone="info">
          {t.rich('simulatedCatalog', { provider: target.simulates ?? '', strong: (chunks) => <strong>{chunks}</strong> })}
        </Notice>
      ) : null}
      {[...byKind.entries()].map(([kind, caps]) => (
        <section key={kind}>
          <h3 className="mb-1.5 font-mono text-xs font-semibold text-fg-muted">{kind}</h3>
          <ul className="space-y-2">
            {caps.map((c) => (
              <li key={c.capability} className="rounded-md border border-border p-2.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-sm font-medium">{c.displayName}</span>
                  <code className="font-mono text-[11px] text-fg-subtle">{c.capability}</code>
                  {c.isDefault ? <Badge tone="info">{t('default')}</Badge> : null}
                </div>
                {c.features.length > 0 ? (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {c.features.map((f) => (
                      <Badge key={f} tone="ok">
                        {f}
                      </Badge>
                    ))}
                  </div>
                ) : null}
                {c.limitations.length > 0 ? (
                  <ul className="mt-1.5 list-disc pl-5 text-xs text-fg-muted">
                    {c.limitations.map((l, i) => (
                      <li key={i}>{l}</li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

const SIMULATED = ['aws', 'azure', 'oci'] as const;
const REGION_HINT: Record<string, string> = {
  aws: 'us-east-1, eu-west-1',
  azure: 'eastus, westeurope',
  gcp: 'us-central1, europe-west1',
  oci: 'us-ashburn-1, eu-frankfurt-1',
  mock: 'us-east-1, eu-west-1',
};

type FormT = ReturnType<typeof useTranslations<'cloudTargets.form'>>;

/** UI level form; the request is assembled and checked with createCloudTargetSchema on submit. */
function registerFormSchema(t: FormT) {
  return z
    .object({
      provider: z.enum(PROVIDERS),
      name: z.string().min(2).max(80),
      environment: z.string().min(1),
      tenantId: z.string(),
      accountId: z.string(),
      roleArn: z.string(),
      credentialRef: z.string(),
      simulate: z.enum(SIMULATED),
      regions: z.string(),
      defaultRegion: z.string(),
      maxConcurrentDeployments: z.number().int().min(1).max(20),
      extraConfig: z.string(),
    })
    .superRefine((v, ctx) => {
      if (v.provider === 'aws') {
        if (!/^\d{12}$/.test(v.accountId)) ctx.addIssue({ code: 'custom', path: ['accountId'], message: t('accountId') });
        if (!/^arn:aws[a-z-]*:iam::\d{12}:role\/.+$/.test(v.roleArn)) ctx.addIssue({ code: 'custom', path: ['roleArn'], message: t('roleArn') });
      }
      if (v.credentialRef && !SECRET_REF_PATTERN.test(v.credentialRef)) {
        ctx.addIssue({ code: 'custom', path: ['credentialRef'], message: t('credentialRef') });
      }
      const regions = splitList(v.regions);
      if (regions.length === 0) ctx.addIssue({ code: 'custom', path: ['regions'], message: t('regionsRequired') });
      if (v.defaultRegion && !regions.includes(v.defaultRegion)) ctx.addIssue({ code: 'custom', path: ['defaultRegion'], message: t('defaultRegionInvalid') });
      if (v.extraConfig.trim()) {
        try {
          const parsed: unknown = JSON.parse(v.extraConfig);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
          const bad = Object.keys(parsed).filter(looksLikeSecretKey);
          if (bad.length) ctx.addIssue({ code: 'custom', path: ['extraConfig'], message: t('secretKeys', { keys: bad.join(', ') }) });
        } catch {
          ctx.addIssue({ code: 'custom', path: ['extraConfig'], message: t('jsonObject') });
        }
      }
    });
}
type RegisterForm = z.infer<ReturnType<typeof registerFormSchema>>;

function RegisterForm({ onDone }: { onDone: () => void }) {
  const t = useTranslations('cloudTargets.form');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const tenants = useTenants();
  const [requestError, setRequestError] = useState<string | null>(null);
  const schema = useMemo(() => registerFormSchema(t), [t]);
  const form = useForm<RegisterForm>({
    resolver: useZodResolver(schema),
    defaultValues: {
      provider: 'mock',
      name: '',
      environment: 'production',
      tenantId: '',
      accountId: '',
      roleArn: '',
      credentialRef: '',
      simulate: 'aws',
      regions: 'us-east-1, eu-west-1',
      defaultRegion: '',
      maxConcurrentDeployments: 3,
      extraConfig: '',
    },
  });
  const { errors } = form.formState;
  const provider = form.watch('provider');
  const regions = splitList(form.watch('regions'));

  const create = useMutation({
    mutationFn: (body: unknown) => apiSend<CloudTargetDto>('POST', '/cloud/targets', body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['cloud-targets'] });
      onDone();
    },
  });

  const onSubmit = form.handleSubmit((v) => {
    setRequestError(null);
    const allowedRegions = splitList(v.regions);
    const extra = v.extraConfig.trim() ? (JSON.parse(v.extraConfig) as Record<string, unknown>) : {};
    const config: Record<string, unknown> =
      v.provider === 'aws' ? { ...extra, accountId: v.accountId, roleArn: v.roleArn } : v.provider === 'mock' ? { ...extra, simulate: v.simulate } : extra;
    const parsed = createCloudTargetSchema.safeParse({
      provider: v.provider,
      name: v.name,
      environment: v.environment,
      config,
      credentialRef: v.credentialRef || undefined,
      allowedRegions,
      defaultRegion: v.defaultRegion || allowedRegions[0] || '',
      tenantId: v.tenantId || undefined,
      maxConcurrentDeployments: v.maxConcurrentDeployments,
    });
    if (!parsed.success) {
      setRequestError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(' · '));
      return;
    }
    create.mutate(parsed.data);
  });

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('provider')} htmlFor="ct-provider" required>
          <Select id="ct-provider" {...form.register('provider')}>
            {PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {p === 'mock' ? t('mockOption') : p}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('name')} htmlFor="ct-name" error={errors.name?.message} required>
          <Input id="ct-name" placeholder={t('namePlaceholder')} {...describedBy('ct-name', { error: errors.name })} {...form.register('name')} />
        </Field>
      </div>

      {provider === 'mock' ? (
        <Field label={t('simulate')} htmlFor="ct-simulate" hint={t('simulateHint')} required>
          <Select id="ct-simulate" {...describedBy('ct-simulate', { hint: true })} {...form.register('simulate')}>
            {SIMULATED.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}

      {provider === 'aws' ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('accountIdLabel')} htmlFor="ct-account" error={errors.accountId?.message} required>
            <Input id="ct-account" inputMode="numeric" className="font-mono" placeholder="123456789012" {...describedBy('ct-account', { error: errors.accountId })} {...form.register('accountId')} />
          </Field>
          <Field label={t('roleArnLabel')} htmlFor="ct-role" error={errors.roleArn?.message} required>
            <Input id="ct-role" className="font-mono" placeholder="arn:aws:iam::123456789012:role/co-deploy" {...describedBy('ct-role', { error: errors.roleArn })} {...form.register('roleArn')} />
          </Field>
          <Field
            label={t('externalId')}
            htmlFor="ct-cred"
            className="sm:col-span-2"
            hint={t.rich('externalIdHint', { code: (chunks) => <code className="font-mono">{chunks}</code> })}
            error={errors.credentialRef?.message}
          >
            <Input id="ct-cred" className="font-mono" autoComplete="off" placeholder="env://NAME" {...describedBy('ct-cred', { hint: true, error: errors.credentialRef })} {...form.register('credentialRef')} />
          </Field>
        </div>
      ) : null}

      {provider === 'azure' || provider === 'gcp' || provider === 'oci' ? (
        <Notice tone="info">{t('noAdapterFields', { provider })}</Notice>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('regions')} htmlFor="ct-regions" hint={t('regionsHint')} error={errors.regions?.message} required>
          <Input id="ct-regions" className="font-mono" placeholder={REGION_HINT[provider]} {...describedBy('ct-regions', { hint: true, error: errors.regions })} {...form.register('regions')} />
        </Field>
        <Field label={t('defaultRegion')} htmlFor="ct-default" error={errors.defaultRegion?.message}>
          <Select id="ct-default" {...form.register('defaultRegion')}>
            <option value="">{regions[0] ? t('firstRegion', { region: regions[0] }) : tc('empty')}</option>
            {regions.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <Disclosure summary={t('advanced')}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('environment')} htmlFor="ct-env">
            <Input id="ct-env" {...form.register('environment')} />
          </Field>
          <Field label={t('scope')} htmlFor="ct-tenant" hint={t('scopeHint')}>
            <Select id="ct-tenant" {...form.register('tenantId')}>
              <option value="">{t('sharedOption')}</option>
              {(tenants.data ?? []).map((tenant) => (
                <option key={tenant.id} value={tenant.id}>
                  {tenant.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('maxConcurrent')} htmlFor="ct-max" error={errors.maxConcurrentDeployments?.message}>
            <Input id="ct-max" type="number" min={1} max={20} {...form.register('maxConcurrentDeployments', { valueAsNumber: true })} />
          </Field>
          {provider !== 'aws' ? (
            <Field label={t('credential')} htmlFor="ct-cred2" hint={t('credentialHint')} error={errors.credentialRef?.message}>
              <Input id="ct-cred2" className="font-mono" autoComplete="off" {...form.register('credentialRef')} />
            </Field>
          ) : null}
        </div>
        <Field label={t('extra')} htmlFor="ct-extra" hint={t('extraHint')} error={errors.extraConfig?.message}>
          <Textarea id="ct-extra" className="font-mono text-xs" placeholder='{ "seed": "demo" }' {...form.register('extraConfig')} />
        </Field>
      </Disclosure>

      {requestError ? <ErrorNotice error={new Error(requestError)} /> : null}
      {create.error ? <ErrorNotice error={create.error} /> : null}
      <div className="flex justify-end gap-2 border-t border-border pt-3">
        <Button onClick={onDone}>{tc('cancel')}</Button>
        <Button type="submit" variant="primary" loading={create.isPending}>
          {t('submit')}
        </Button>
      </div>
    </form>
  );
}
