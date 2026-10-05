'use client';

import {
  createInstanceSchema,
  ENVIRONMENTS,
  type CloudTargetDto,
  type CreateInstanceInput,
  type InstanceDto,
  type TemplateDto,
  type TemplateVersionDto,
  type TenantDto,
} from '@co/contracts';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, Copy } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Badge, SimulatedBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorNotice, Notice } from '@/components/ui/error-notice';
import { describedBy, Field, Input } from '@/components/ui/input';
import { Disclosure, KeyValues, PageHeader } from '@/components/ui/page-header';
import { Select } from '@/components/ui/select';
import { PageSpinner, Spinner } from '@/components/ui/spinner';
import { StatusBadge } from '@/components/ui/status-badge';
import { apiSend } from '@/lib/api';
import { useCloudTargets, useTemplate, useTemplates, useTenants } from '@/lib/queries';
import { checkVariable, readTemplateDoc, type PlacementSlot, type TemplateDocView, type TemplateVariable } from '@/lib/template-doc';
import { cn, slugify } from '@/lib/utils';

type StepId = 'tenant' | 'template' | 'placement' | 'variables' | 'details' | 'review';
const STEPS: { id: StepId; label: string }[] = [
  { id: 'tenant', label: 'Tenant' },
  { id: 'template', label: 'Template' },
  { id: 'placement', label: 'Placement' },
  { id: 'variables', label: 'Variables' },
  { id: 'details', label: 'Name & environment' },
  { id: 'review', label: 'Review & create' },
];

type Binding = { targetId: string; region: string };
type VarValue = string | number | boolean;
interface Details {
  name: string;
  slug: string;
  environment: (typeof ENVIRONMENTS)[number];
}

export default function NewInstancePage() {
  const router = useRouter();
  const qc = useQueryClient();
  const tenants = useTenants();
  const templates = useTemplates();
  const targets = useCloudTargets();

  const [step, setStep] = useState<StepId>('tenant');
  const [tenantId, setTenantId] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [versionId, setVersionId] = useState('');
  const [bindings, setBindings] = useState<Record<string, Binding>>({});
  const [variables, setVariables] = useState<Record<string, VarValue>>({});
  const [details, setDetails] = useState<Details>({ name: '', slug: '', environment: 'production' });

  // A single tenant? Preselect it.
  useEffect(() => {
    if (!tenantId && tenants.data?.length === 1) setTenantId(tenants.data[0]!.id);
  }, [tenants.data, tenantId]);

  const template = useTemplate(templateId || null);
  const templateSummary = templates.data?.find((t) => t.id === templateId) ?? null;
  const publishedVersions: TemplateVersionDto[] = useMemo(() => {
    const fromDetail = template.data?.versions?.filter((v) => v.status === 'PUBLISHED') ?? [];
    if (fromDetail.length > 0) return fromDetail;
    return templateSummary?.latestPublished ? [templateSummary.latestPublished] : [];
  }, [template.data, templateSummary]);
  const version = publishedVersions.find((v) => v.id === versionId) ?? null;
  const doc = useMemo(() => (version ? readTemplateDoc(version.document) : null), [version]);

  // Reset dependent state when the template version changes; seed variable defaults.
  const [seededFor, setSeededFor] = useState<string | null>(null);
  useEffect(() => {
    if (!doc || !version || seededFor === version.id) return;
    setSeededFor(version.id);
    setVariables(Object.fromEntries(doc.variables.map((v) => [v.name, v.default])));
    setBindings({});
  }, [doc, version, seededFor]);

  const tenant = tenants.data?.find((t) => t.id === tenantId) ?? null;

  const eligibleTargets = (slot: PlacementSlot): CloudTargetDto[] =>
    (targets.data ?? []).filter(
      (t) => t.status === 'ACTIVE' && (t.tenantId === null || t.tenantId === tenantId) && (slot.providers.length === 0 || slot.providers.includes(t.provider)),
    );

  const variableErrors = doc ? Object.fromEntries(doc.variables.map((v) => [v.name, checkVariable(v, variables[v.name])])) : {};

  const canAdvance: Record<StepId, boolean> = {
    tenant: !!tenantId,
    template: !!version && !!doc,
    placement: !!doc && doc.placements.every((s) => bindings[s.name]?.targetId && bindings[s.name]?.region),
    variables: Object.values(variableErrors).every((e) => e === null),
    details: !!details.name && !!details.slug,
    review: true,
  };

  const stepIndex = STEPS.findIndex((s) => s.id === step);
  const go = (delta: number) => {
    const next = STEPS[stepIndex + delta];
    if (next) setStep(next.id);
  };

  const payload: CreateInstanceInput = {
    tenantId,
    templateVersionId: versionId,
    name: details.name,
    slug: details.slug,
    environment: details.environment,
    variables,
    bindings,
  };
  const parsed = createInstanceSchema.safeParse(payload);

  const create = useMutation({
    mutationFn: (input: CreateInstanceInput) => apiSend<InstanceDto>('POST', '/instances', input),
    onSuccess: (instance) => {
      void qc.invalidateQueries({ queryKey: ['instances'] });
      router.push(`/instances/${instance.id}?tab=plan`);
    },
  });

  if (tenants.isPending || templates.isPending) return <PageSpinner />;

  return (
    <>
      <PageHeader
        title="New instance"
        description="Put a new environment on stage from a template. Nothing is created in the cloud until you review the plan and deploy."
        breadcrumb={
          <Link href="/instances" className="hover:underline">
            Instances
          </Link>
        }
      />

      <ol className="mb-5 flex flex-wrap gap-1.5" aria-label="Steps">
        {STEPS.map((s, i) => {
          const done = i < stepIndex;
          const current = i === stepIndex;
          const reachable = i <= stepIndex || STEPS.slice(0, i).every((p) => canAdvance[p.id]);
          return (
            <li key={s.id}>
              <button
                type="button"
                disabled={!reachable || current}
                onClick={() => setStep(s.id)}
                aria-current={current ? 'step' : undefined}
                className={cn(
                  'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs',
                  current && 'border-accent bg-accent/10 font-medium text-accent-ink',
                  done && 'border-border text-fg-muted hover:bg-surface-2',
                  !current && !done && 'border-border text-fg-subtle',
                  !reachable && 'opacity-60',
                )}
              >
                <span className={cn('flex h-4 w-4 items-center justify-center rounded-full text-[10px]', done ? 'bg-ok text-accent-fg' : 'bg-surface-2')}>
                  {done ? <Check size={10} aria-hidden /> : i + 1}
                </span>
                {s.label}
              </button>
            </li>
          );
        })}
      </ol>

      <Card>
        <CardBody className="py-4">
          {step === 'tenant' ? <TenantStep tenants={tenants.data ?? []} value={tenantId} onChange={setTenantId} error={tenants.error} /> : null}

          {step === 'template' ? (
            <TemplateStep
              templates={templates.data ?? []}
              error={templates.error}
              tenant={tenant}
              templateId={templateId}
              onTemplate={(t) => {
                setTemplateId(t.id);
                setVersionId(t.latestPublished?.id ?? '');
              }}
              versions={publishedVersions}
              versionsLoading={template.isFetching}
              versionId={versionId}
              onVersion={setVersionId}
              doc={doc}
            />
          ) : null}

          {step === 'placement' && doc ? (
            <PlacementStep
              slots={doc.placements}
              bindings={bindings}
              setBindings={setBindings}
              eligible={eligibleTargets}
              loading={targets.isPending}
              error={targets.error}
            />
          ) : null}

          {step === 'variables' && doc ? (
            <VariablesStep vars={doc.variables} values={variables} errors={variableErrors} onChange={(name, value) => setVariables((prev) => ({ ...prev, [name]: value }))} />
          ) : null}

          {step === 'details' ? (
            <DetailsStep
              initial={details}
              nonProduction={doc?.nonProduction ?? false}
              onSubmit={(d) => {
                setDetails(d);
                setStep('review');
              }}
              onBack={() => go(-1)}
            />
          ) : null}

          {step === 'review' && doc && version ? (
            <ReviewStep
              tenant={tenant}
              template={templateSummary}
              version={version}
              doc={doc}
              bindings={bindings}
              targets={targets.data ?? []}
              variables={variables}
              details={details}
              issues={parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join('.') || 'request'}: ${i.message}`)}
            />
          ) : null}

          {create.error ? <ErrorNotice error={create.error} title="The instance could not be created" className="mt-4" /> : null}
        </CardBody>

        {step !== 'details' ? (
          <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-3">
            <Button onClick={() => go(-1)} disabled={stepIndex === 0}>
              Back
            </Button>
            {step === 'review' ? (
              <Button variant="primary" disabled={!parsed.success} loading={create.isPending} onClick={() => parsed.success && create.mutate(payload)}>
                Create instance
              </Button>
            ) : (
              <Button variant="primary" disabled={!canAdvance[step]} onClick={() => go(1)}>
                Continue
              </Button>
            )}
          </div>
        ) : null}
      </Card>
    </>
  );
}

function StepTitle({ title, description }: { title: string; description?: string }) {
  return (
    <div className="mb-4">
      <h2 className="text-base font-semibold">{title}</h2>
      {description ? <p className="text-xs text-fg-subtle">{description}</p> : null}
    </div>
  );
}

function TenantStep({ tenants, value, onChange, error }: { tenants: TenantDto[]; value: string; onChange: (id: string) => void; error: unknown }) {
  if (error) return <ErrorNotice error={error} />;
  if (tenants.length === 0) return <EmptyState title="No tenants available" description="Create a tenant first." />;
  return (
    <fieldset>
      <legend className="sr-only">Tenant</legend>
      <StepTitle title="Choose the customer" description="The instance and its cost belong to this tenant." />
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {tenants.map((t) => (
          <label
            key={t.id}
            className={cn(
              'flex cursor-pointer items-start gap-2.5 rounded-md border p-3 hover:bg-surface-2',
              value === t.id ? 'border-accent ring-1 ring-accent' : 'border-border',
            )}
          >
            <input type="radio" name="tenant" value={t.id} checked={value === t.id} onChange={() => onChange(t.id)} className="mt-0.5 accent-accent" />
            <span className="min-w-0">
              <span className="block font-medium">{t.name}</span>
              <span className="block font-mono text-[11px] text-fg-subtle">{t.slug}</span>
              <span className="mt-1 flex gap-1.5">
                <Badge tone="info">{t.plan.name}</Badge>
                <Badge>{t.instanceCount} instances</Badge>
              </span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function TemplateStep({
  templates,
  error,
  tenant,
  templateId,
  onTemplate,
  versions,
  versionsLoading,
  versionId,
  onVersion,
  doc,
}: {
  templates: TemplateDto[];
  error: unknown;
  tenant: TenantDto | null;
  templateId: string;
  onTemplate: (t: TemplateDto) => void;
  versions: TemplateVersionDto[];
  versionsLoading: boolean;
  versionId: string;
  onVersion: (id: string) => void;
  doc: TemplateDocView | null;
}) {
  if (error) return <ErrorNotice error={error} />;
  const published = templates.filter((t) => t.latestPublished);
  if (published.length === 0) return <EmptyState title="No published templates" description="Publish a template version before creating instances." />;
  return (
    <div className="space-y-4">
      <fieldset>
        <legend className="sr-only">Template</legend>
        <StepTitle title="Choose a template" description="A template is the blueprint: services, data and networking. Only published versions can be used." />
        <div className="grid gap-2 md:grid-cols-2">
          {published.map((t) => {
            const d = readTemplateDoc(t.latestPublished!.document);
            const planMismatch = tenant && d.plans.length > 0 && !d.plans.includes(tenant.plan.code);
            return (
              <label
                key={t.id}
                className={cn(
                  'flex cursor-pointer items-start gap-2.5 rounded-md border p-3 hover:bg-surface-2',
                  templateId === t.id ? 'border-accent ring-1 ring-accent' : 'border-border',
                )}
              >
                <input type="radio" name="template" checked={templateId === t.id} onChange={() => onTemplate(t)} className="mt-0.5 accent-accent" />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium">{t.displayName}</span>
                    <span className="font-mono text-[11px] text-fg-subtle">@{t.latestPublished!.version}</span>
                    {t.visibility === 'SYSTEM' ? <Badge>System</Badge> : null}
                    {d.nonProduction ? <Badge tone="warn">Non-production</Badge> : null}
                  </span>
                  <span className="mt-1 line-clamp-2 block text-xs text-fg-muted">{t.description || d.description}</span>
                  <span className="mt-1.5 flex flex-wrap gap-1">
                    {d.plans.map((p) => (
                      <Badge key={p} tone={tenant?.plan.code === p ? 'info' : 'neutral'}>
                        {p}
                      </Badge>
                    ))}
                    <Badge>{d.placements.length} placement{d.placements.length === 1 ? '' : 's'}</Badge>
                    <Badge>{d.resourceCount} resources</Badge>
                  </span>
                  {planMismatch ? (
                    <span className="mt-1.5 block text-xs text-warn-ink">Not listed for the {tenant.plan.name} plan; the API may reject it.</span>
                  ) : null}
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      {templateId ? (
        <div className="space-y-3 border-t border-border pt-4">
          <Field label="Version" htmlFor="template-version" hint="Published versions are immutable.">
            <div className="flex items-center gap-2">
              <Select id="template-version" value={versionId} onChange={(e) => onVersion(e.target.value)} className="w-56">
                {versions.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.version}
                    {v.publishedAt ? ` — published ${new Date(v.publishedAt).toLocaleDateString()}` : ''}
                  </option>
                ))}
              </Select>
              {versionsLoading ? <Spinner size={14} label="Loading versions" /> : null}
            </div>
          </Field>
          {doc ? (
            <>
              {doc.description ? <p className="text-sm text-fg-muted">{doc.description}</p> : null}
              {doc.nonProduction ? (
                <Notice tone="warn">
                  <span className="flex items-start gap-2">
                    <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warn-ink" aria-hidden />
                    <span>
                      <strong>Not for production.</strong> This template trades resilience for cost (single zone, minimal sizes, no HA, short retention). Use it for validation and sandboxes only.
                    </span>
                  </span>
                </Notice>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function targetLabel(t: CloudTargetDto): string {
  const sim = t.simulated ? ` — simulates ${t.simulates ?? 'cloud'}` : '';
  return `${t.name} (${t.provider}${sim}) · ${t.environment}`;
}

function PlacementStep({
  slots,
  bindings,
  setBindings,
  eligible,
  loading,
  error,
}: {
  slots: PlacementSlot[];
  bindings: Record<string, Binding>;
  setBindings: (fn: (prev: Record<string, Binding>) => Record<string, Binding>) => void;
  eligible: (slot: PlacementSlot) => CloudTargetDto[];
  loading: boolean;
  error: unknown;
}) {
  const [note, setNote] = useState<string | null>(null);
  if (loading) return <PageSpinner label="Loading cloud targets" />;
  if (error) return <ErrorNotice error={error} />;

  const first = slots[0];
  const firstBinding = first ? bindings[first.name] : undefined;

  const useSameForAll = () => {
    if (!firstBinding?.targetId) return;
    const compatible = slots.filter((slot) => eligible(slot).some((t) => t.id === firstBinding.targetId));
    const skipped = slots.filter((slot) => !compatible.includes(slot)).map((s) => s.name);
    setBindings((prev) => {
      const next = { ...prev };
      for (const slot of compatible) next[slot.name] = { ...firstBinding };
      return next;
    });
    setNote(skipped.length ? `The target does not support slot(s): ${skipped.join(', ')}. Pick a target for them manually.` : null);
  };

  return (
    <div className="space-y-4">
      <StepTitle title="Choose where each part runs" description="Each placement slot is bound to a cloud target (account) and a region. Slots may use different clouds." />
      {slots.length > 1 ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={useSameForAll} disabled={!firstBinding?.targetId}>
            <Copy size={13} aria-hidden /> Use same target for all slots
          </Button>
          <span className="text-xs text-fg-subtle">Copies the “{first?.name}” binding to every compatible slot (single-cloud deployment).</span>
        </div>
      ) : null}
      {note ? <Notice tone="warn">{note}</Notice> : null}

      <div className="space-y-3">
        {slots.map((slot) => {
          const options = eligible(slot);
          const binding = bindings[slot.name];
          const target = options.find((t) => t.id === binding?.targetId) ?? null;
          const id = `slot-${slot.name}`;
          return (
            <fieldset key={slot.name} className="rounded-md border border-border p-3">
              <legend className="px-1 text-sm font-medium">
                <span className="font-mono">{slot.name}</span>
              </legend>
              {slot.description ? <p className="mb-2 text-xs text-fg-muted">{slot.description}</p> : null}
              <p className="mb-3 flex flex-wrap items-center gap-1 text-xs text-fg-subtle">
                Allowed providers:
                {slot.providers.length === 0 ? <Badge>any</Badge> : slot.providers.map((p) => <Badge key={p}>{p}</Badge>)}
              </p>
              {options.length === 0 ? (
                <Notice tone="warn">
                  No active cloud target supports this slot.{' '}
                  <Link href="/cloud-targets" className="text-accent-ink underline">
                    Register a target
                  </Link>
                  .
                </Notice>
              ) : (
                <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
                  <Field label="Cloud target" htmlFor={`${id}-target`}>
                    <Select
                      id={`${id}-target`}
                      value={binding?.targetId ?? ''}
                      onChange={(e) => {
                        const t = options.find((o) => o.id === e.target.value);
                        setBindings((prev) => ({ ...prev, [slot.name]: { targetId: e.target.value, region: t ? t.defaultRegion || t.allowedRegions[0] || '' : '' } }));
                      }}
                    >
                      <option value="">Select a target…</option>
                      {options.map((t) => (
                        <option key={t.id} value={t.id}>
                          {targetLabel(t)}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Region" htmlFor={`${id}-region`}>
                    <Select
                      id={`${id}-region`}
                      value={binding?.region ?? ''}
                      disabled={!target}
                      onChange={(e) => setBindings((prev) => ({ ...prev, [slot.name]: { targetId: binding?.targetId ?? '', region: e.target.value } }))}
                    >
                      {!target ? <option value="">—</option> : null}
                      {(target?.allowedRegions ?? []).map((r) => (
                        <option key={r} value={r}>
                          {r}
                          {r === target?.defaultRegion ? ' (default)' : ''}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
              )}
              {target ? (
                <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
                  <StatusBadge status={target.health} prefix="Target health" />
                  {target.simulated ? <SimulatedBadge simulates={target.simulates} /> : null}
                  {target.lastValidation && !target.lastValidation.ok ? <Badge tone="warn">Last validation failed</Badge> : null}
                </div>
              ) : null}
            </fieldset>
          );
        })}
      </div>
    </div>
  );
}

function VariablesStep({
  vars,
  values,
  errors,
  onChange,
}: {
  vars: TemplateVariable[];
  values: Record<string, VarValue>;
  errors: Record<string, string | null>;
  onChange: (name: string, value: VarValue) => void;
}) {
  if (vars.length === 0) {
    return (
      <>
        <StepTitle title="Variables" />
        <p className="text-sm text-fg-muted">This template has no variables. Its sizing is fixed by the template author.</p>
      </>
    );
  }
  return (
    <div>
      <StepTitle title="Configure variables" description="Defaults are pre-filled. Values are validated again by the API." />
      <div className="grid gap-4 sm:grid-cols-2">
        {vars.map((v) => {
          const id = `var-${v.name}`;
          const value = values[v.name];
          const error = errors[v.name] ?? null;
          const range = v.type === 'number' && (v.min !== undefined || v.max !== undefined) ? `Range ${v.min ?? '−∞'} – ${v.max ?? '∞'}` : null;
          const hint = [v.description, range, `Default ${String(v.default)}`].filter(Boolean).join(' · ');
          if (v.type === 'boolean') {
            return (
              <div key={v.name} className="space-y-1">
                <label htmlFor={id} className="flex items-center gap-2 text-sm">
                  <input id={id} type="checkbox" checked={value === true} onChange={(e) => onChange(v.name, e.target.checked)} className="accent-accent" />
                  <span className="font-mono text-xs">{v.name}</span>
                </label>
                <p className="text-xs text-fg-subtle">{hint}</p>
              </div>
            );
          }
          return (
            <Field key={v.name} label={<span className="font-mono">{v.name}</span>} htmlFor={id} hint={hint} error={error}>
              {v.type === 'string' && v.allowed && v.allowed.length > 0 ? (
                <Select id={id} value={String(value ?? '')} onChange={(e) => onChange(v.name, e.target.value)} {...describedBy(id, { hint, error })}>
                  {v.allowed.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </Select>
              ) : v.type === 'number' ? (
                <Input
                  id={id}
                  type="number"
                  inputMode="decimal"
                  step="any"
                  min={v.min}
                  max={v.max}
                  value={typeof value === 'number' && !Number.isNaN(value) ? value : ''}
                  onChange={(e) => onChange(v.name, e.target.value === '' ? Number.NaN : Number(e.target.value))}
                  {...describedBy(id, { hint, error })}
                />
              ) : (
                <Input id={id} value={String(value ?? '')} onChange={(e) => onChange(v.name, e.target.value)} {...describedBy(id, { hint, error })} />
              )}
            </Field>
          );
        })}
      </div>
    </div>
  );
}

const detailsSchema = createInstanceSchema.pick({ name: true, slug: true, environment: true });

function DetailsStep({ initial, nonProduction, onSubmit, onBack }: { initial: Details; nonProduction: boolean; onSubmit: (d: Details) => void; onBack: () => void }) {
  const [slugTouched, setSlugTouched] = useState(Boolean(initial.slug));
  const form = useForm({ resolver: zodResolver(detailsSchema), defaultValues: initial });
  const { errors } = form.formState;
  const env = form.watch('environment');
  const nameField = form.register('name', {
    onChange: (e: { target: { value: string } }) => {
      if (!slugTouched) form.setValue('slug', slugify(e.target.value));
    },
  });

  return (
    <form onSubmit={form.handleSubmit((d) => onSubmit({ name: d.name, slug: d.slug, environment: d.environment }))} noValidate>
      <StepTitle title="Name and environment" />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Display name" htmlFor="inst-name" error={errors.name?.message} required>
          <Input id="inst-name" autoFocus placeholder="Acme production" {...describedBy('inst-name', { error: errors.name })} {...nameField} />
        </Field>
        <Field label="Slug" htmlFor="inst-slug" hint="Used in resource names and URLs. Needed later to confirm destroy." error={errors.slug?.message} required>
          <Input id="inst-slug" className="font-mono" {...describedBy('inst-slug', { hint: true, error: errors.slug })} {...form.register('slug', { onChange: () => setSlugTouched(true) })} />
        </Field>
        <Field label="Environment" htmlFor="inst-env" error={errors.environment?.message}>
          <Select id="inst-env" {...form.register('environment')}>
            {ENVIRONMENTS.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {nonProduction && env === 'production' ? (
        <Notice tone="warn" className="mt-4">
          The selected template is marked non-production. Consider using a sandbox or development environment.
        </Notice>
      ) : null}
      <div className="-mx-4 -mb-4 mt-5 flex items-center justify-between gap-2 border-t border-border px-4 py-3">
        <Button onClick={onBack}>Back</Button>
        <Button type="submit" variant="primary">
          Continue
        </Button>
      </div>
    </form>
  );
}

function ReviewStep({
  tenant,
  template,
  version,
  doc,
  bindings,
  targets,
  variables,
  details,
  issues,
}: {
  tenant: TenantDto | null;
  template: TemplateDto | null;
  version: TemplateVersionDto;
  doc: TemplateDocView;
  bindings: Record<string, Binding>;
  targets: CloudTargetDto[];
  variables: Record<string, VarValue>;
  details: Details;
  issues: string[];
}) {
  const byId = new Map(targets.map((t) => [t.id, t]));
  const anySimulated = Object.values(bindings).some((b) => byId.get(b.targetId)?.simulated);
  const providers = new Set(Object.values(bindings).map((b) => byId.get(b.targetId)?.provider ?? '?'));
  return (
    <div className="space-y-4">
      <StepTitle title="Review" description="Creating the instance stores its definition. You will preview the plan and estimated cost next, then deploy." />
      {issues.length > 0 ? (
        <ErrorNotice error={new Error(issues.join(' · '))} title="Some values are invalid" />
      ) : null}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Instance" as="h3" />
          <CardBody>
            <KeyValues
              items={[
                { label: 'Tenant', value: tenant ? `${tenant.name} (${tenant.plan.name})` : '—' },
                { label: 'Name', value: details.name },
                { label: 'Slug', value: <code className="font-mono text-xs">{details.slug}</code> },
                { label: 'Environment', value: details.environment },
                {
                  label: 'Template',
                  value: (
                    <span>
                      {template?.displayName ?? doc.displayName} <span className="font-mono text-xs text-fg-subtle">@{version.version}</span>
                      {doc.nonProduction ? <Badge tone="warn" className="ml-1.5">Non-production</Badge> : null}
                    </span>
                  ),
                },
              ]}
            />
          </CardBody>
        </Card>
        <Card>
          <CardHeader
            title="Placement"
            as="h3"
            actions={
              <>
                {providers.size > 1 ? <Badge tone="info">Multi-cloud</Badge> : null}
                {anySimulated ? <SimulatedBadge /> : null}
              </>
            }
          />
          <CardBody>
            <ul className="space-y-1.5 text-sm">
              {doc.placements.map((s) => {
                const b = bindings[s.name];
                const t = b ? byId.get(b.targetId) : undefined;
                return (
                  <li key={s.name} className="flex flex-wrap items-center gap-x-2">
                    <span className="w-20 font-mono text-xs text-fg-subtle">{s.name}</span>
                    <span>{t?.name ?? '—'}</span>
                    <span className="font-mono text-xs text-fg-muted">
                      {t?.provider}
                      {t?.simulated ? `→${t.simulates}` : ''} / {b?.region}
                    </span>
                  </li>
                );
              })}
            </ul>
          </CardBody>
        </Card>
      </div>
      {doc.variables.length > 0 ? (
        <Disclosure summary={`Variables (${doc.variables.filter((v) => variables[v.name] !== v.default).length} changed from default)`}>
          <KeyValues
            items={doc.variables.map((v) => ({
              label: <span className="font-mono text-xs">{v.name}</span>,
              value: (
                <span className={cn(variables[v.name] !== v.default && 'font-medium text-accent-ink')}>
                  {String(variables[v.name])}
                  {variables[v.name] !== v.default ? <span className="ml-1 text-xs text-fg-subtle">(default {String(v.default)})</span> : null}
                </span>
              ),
            }))}
          />
        </Disclosure>
      ) : null}
    </div>
  );
}
