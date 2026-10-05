'use client';

import { cloneTemplateSchema, PLAN_CODES, type TemplateDto, type TemplateVersionDto, type ValidationIssueDto } from '@co/contracts';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Copy, FilePlus2, Send, Workflow } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { IssuesList } from '@/components/plan-view';
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { ErrorNotice, Notice } from '@/components/ui/error-notice';
import { describedBy, Field, Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { Select } from '@/components/ui/select';
import { PageSpinner } from '@/components/ui/spinner';
import { StatusBadge } from '@/components/ui/status-badge';
import { Textarea } from '@/components/ui/textarea';
import { YamlViewer } from '@/components/yaml-viewer';
import { apiSend, isApiError } from '@/lib/api';
import { useCan } from '@/lib/ability';
import { useTemplate } from '@/lib/queries';
import { readTemplateDoc } from '@/lib/template-doc';
import { cn, formatDateTime } from '@/lib/utils';

interface ValidationReport {
  valid: boolean;
  issues: ValidationIssueDto[];
}

/** Publish/create failures may carry validation issues in `error.details.issues`. */
function issuesFromError(err: unknown): ValidationIssueDto[] {
  if (!isApiError(err)) return [];
  const issues = err.details.issues;
  return Array.isArray(issues) ? (issues as ValidationIssueDto[]) : [];
}

export default function TemplatePage() {
  const { id } = useParams<{ id: string }>();
  const q = useTemplate(id);
  const can = useCan();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [cloning, setCloning] = useState(false);

  if (q.isPending) return <PageSpinner />;
  if (q.error) return <ErrorNotice error={q.error} title="Template unavailable" />;
  const t = q.data;
  const versions = [...(t.versions ?? (t.latestPublished ? [t.latestPublished] : []))].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const selected = versions.find((v) => v.id === selectedId) ?? versions[0] ?? null;
  const doc = selected ? readTemplateDoc(selected.document) : null;

  return (
    <>
      <PageHeader
        breadcrumb={
          <Link href="/templates" className="hover:underline">
            Templates
          </Link>
        }
        title={t.displayName}
        description={t.description}
        meta={
          <>
            <code className="font-mono text-xs text-fg-subtle">{t.name}</code>
            {t.visibility === 'SYSTEM' ? <Badge tone="info">System</Badge> : <Badge>Organization</Badge>}
            {doc?.nonProduction ? <Badge tone="warn">Non-production</Badge> : null}
          </>
        }
        actions={
          <>
            <ButtonLink href={`/templates/${t.id}/builder${selected ? `?version=${selected.id}` : ''}`}>
              <Workflow size={14} aria-hidden /> {t.visibility === 'SYSTEM' || !can('update', 'Template') ? 'View in builder' : 'Open in builder'}
            </ButtonLink>
            {can('create', 'Template') ? (
              <Button onClick={() => setCloning(true)}>
                <Copy size={14} aria-hidden /> Clone
              </Button>
            ) : null}
            {can('update', 'Template') && !editing ? (
              <Button variant="primary" onClick={() => setEditing(true)}>
                <FilePlus2 size={14} aria-hidden /> New version
              </Button>
            ) : null}
          </>
        }
      />

      {editing ? (
        <VersionEditor
          template={t}
          initialSource={selected?.source ?? ''}
          onClose={() => setEditing(false)}
          onSaved={(v) => setSelectedId(v.id)}
        />
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]">
        <Card>
          <CardHeader title="Versions" as="h2" />
          <ul className="divide-y divide-border">
            {versions.map((v) => (
              <li key={v.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(v.id)}
                  aria-current={selected?.id === v.id ? 'true' : undefined}
                  className={cn('flex w-full items-center justify-between gap-2 px-4 py-2 text-left hover:bg-surface-2', selected?.id === v.id && 'bg-accent/8')}
                >
                  <span>
                    <code className="block font-mono text-sm">{v.version}</code>
                    <span className="text-[11px] text-fg-subtle">{formatDateTime(v.publishedAt ?? v.createdAt)}</span>
                  </span>
                  <span className="flex flex-col items-end gap-1">
                    <StatusBadge status={v.status} />
                    {typeof v.instanceCount === 'number' ? <span className="text-[11px] text-fg-subtle">{v.instanceCount} inst.</span> : null}
                  </span>
                </button>
              </li>
            ))}
            {versions.length === 0 ? <li className="px-4 py-3 text-sm text-fg-subtle">No versions.</li> : null}
          </ul>
        </Card>

        {selected ? <VersionDetail template={t} version={selected} canPublish={can('publish', 'Template')} /> : null}
      </div>

      <Dialog open={cloning} onClose={() => setCloning(false)} title={`Clone ${t.displayName}`} description="Creates an organization template you can edit, starting from this template's latest version.">
        <CloneForm template={t} onDone={() => setCloning(false)} />
      </Dialog>
    </>
  );
}

function VersionDetail({ template, version, canPublish }: { template: TemplateDto; version: TemplateVersionDto; canPublish: boolean }) {
  const qc = useQueryClient();
  const publish = useMutation({
    mutationFn: () => apiSend<TemplateVersionDto>('POST', `/templates/${template.id}/versions/${version.id}/publish`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['template', template.id] });
      void qc.invalidateQueries({ queryKey: ['templates'] });
    },
  });
  const doc = readTemplateDoc(version.document);
  const publishIssues = issuesFromError(publish.error);

  return (
    <div className="min-w-0 space-y-4">
      <Card>
        <CardHeader
          title={
            <span className="flex items-center gap-2">
              Version <code className="font-mono">{version.version}</code> <StatusBadge status={version.status} />
            </span>
          }
          description={`Created ${formatDateTime(version.createdAt)}${version.publishedAt ? ` · published ${formatDateTime(version.publishedAt)}` : ''}`}
          actions={
            version.status === 'DRAFT' && canPublish ? (
              <Button variant="primary" onClick={() => publish.mutate()} loading={publish.isPending}>
                <Send size={14} aria-hidden /> Publish
              </Button>
            ) : null
          }
        />
        <CardBody className="space-y-3">
          <div className="flex flex-wrap gap-1.5 text-xs">
            {doc.plans.map((p) => (
              <Badge key={p}>{p}</Badge>
            ))}
            <Badge>{doc.placements.length} placement slot(s)</Badge>
            <Badge>{doc.resourceCount} resources</Badge>
            <Badge>{doc.variables.length} variables</Badge>
            {doc.profile ? <Badge>profile: {doc.profile}</Badge> : null}
          </div>
          {version.validation ? (
            version.validation.valid && version.validation.issues.length === 0 ? (
              <p className="flex items-center gap-1.5 text-sm text-ok-ink">
                <CheckCircle2 size={14} aria-hidden /> Validation passed
              </p>
            ) : (
              <IssuesList issues={version.validation.issues} />
            )
          ) : (
            <p className="text-xs text-fg-subtle">Not validated yet.</p>
          )}
          {publish.error ? <ErrorNotice error={publish.error} title="Publish refused" /> : null}
          {publishIssues.length > 0 ? <IssuesList issues={publishIssues} /> : null}
          {publish.isSuccess ? <Notice tone="ok">Published. Instances can now use this version.</Notice> : null}
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Source" as="h3" description="YAML as submitted. Published versions are immutable." />
        <CardBody>
          <YamlViewer source={version.source} />
        </CardBody>
      </Card>
    </div>
  );
}

function VersionEditor({ template, initialSource, onClose, onSaved }: { template: TemplateDto; initialSource: string; onClose: () => void; onSaved: (v: TemplateVersionDto) => void }) {
  const qc = useQueryClient();
  const [source, setSource] = useState(initialSource);
  const [planCode, setPlanCode] = useState('');
  const [saved, setSaved] = useState<TemplateVersionDto | null>(null);

  const validate = useMutation({
    mutationFn: () => apiSend<ValidationReport>('POST', `/templates/${template.id}/validate`, { source, ...(planCode ? { planCode } : {}) }),
  });
  const save = useMutation({
    mutationFn: () => apiSend<TemplateVersionDto>('POST', `/templates/${template.id}/versions`, { source }),
    onSuccess: (v) => {
      setSaved(v);
      onSaved(v);
      void qc.invalidateQueries({ queryKey: ['template', template.id] });
    },
  });
  const publish = useMutation({
    mutationFn: (versionId: string) => apiSend<TemplateVersionDto>('POST', `/templates/${template.id}/versions/${versionId}/publish`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['template', template.id] });
      void qc.invalidateQueries({ queryKey: ['templates'] });
      onClose();
    },
  });

  const report = validate.data;
  const issues = report?.issues ?? [];
  const errorIssues = [...issuesFromError(save.error), ...issuesFromError(publish.error)];

  return (
    <Card className="mb-4">
      <CardHeader
        title="New version"
        description="Edit the YAML (bump metadata.version), validate, save as draft, then publish."
        actions={
          <Button size="sm" variant="ghost" onClick={onClose}>
            Close editor
          </Button>
        }
      />
      <CardBody className="space-y-3">
        <label htmlFor="tpl-source" className="sr-only">
          Template YAML
        </label>
        <Textarea
          id="tpl-source"
          value={source}
          onChange={(e) => {
            setSource(e.target.value);
            setSaved(null);
          }}
          spellCheck={false}
          className="min-h-[28rem] font-mono text-xs leading-relaxed"
        />
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label htmlFor="tpl-plan" className="mb-1 block text-xs text-fg-subtle">
              Validate against plan (optional)
            </label>
            <Select id="tpl-plan" value={planCode} onChange={(e) => setPlanCode(e.target.value)} className="w-40">
              <option value="">Any plan</option>
              {PLAN_CODES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </Select>
          </div>
          <Button onClick={() => validate.mutate()} loading={validate.isPending} disabled={!source.trim()}>
            Validate
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!source.trim() || !!saved}>
            Save draft
          </Button>
          <Button variant="primary" onClick={() => saved && publish.mutate(saved.id)} loading={publish.isPending} disabled={!saved} title={!saved ? 'Save a draft first' : undefined}>
            <Send size={14} aria-hidden /> Publish
          </Button>
          {saved ? <span className="text-xs text-ok-ink">Saved as draft {saved.version}</span> : null}
        </div>
        {validate.error ? <ErrorNotice error={validate.error} /> : null}
        {report ? (
          report.valid && issues.length === 0 ? (
            <Notice tone="ok">Valid — no issues found.</Notice>
          ) : (
            <div className="space-y-2">
              <p className="text-sm font-medium">{report.valid ? 'Valid with warnings' : 'Invalid'}</p>
              <IssuesList issues={issues} />
            </div>
          )
        ) : null}
        {save.error ? <ErrorNotice error={save.error} title="Could not save the draft" /> : null}
        {publish.error ? <ErrorNotice error={publish.error} title="Publish refused" /> : null}
        {errorIssues.length > 0 ? <IssuesList issues={errorIssues} /> : null}
      </CardBody>
    </Card>
  );
}

function CloneForm({ template, onDone }: { template: TemplateDto; onDone: () => void }) {
  const router = useRouter();
  const qc = useQueryClient();
  const form = useForm({
    resolver: zodResolver(cloneTemplateSchema),
    defaultValues: { name: `${template.name}-copy`.slice(0, 63), displayName: `${template.displayName} (copy)`.slice(0, 80) },
  });
  const { errors } = form.formState;
  const clone = useMutation({
    mutationFn: (v: { name: string; displayName: string }) => apiSend<TemplateDto>('POST', `/templates/${template.id}/clone`, v),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ['templates'] });
      onDone();
      router.push(`/templates/${res.id}`);
    },
  });
  return (
    <form onSubmit={form.handleSubmit((v) => clone.mutate(v))} className="space-y-4" noValidate>
      <Field label="Name" htmlFor="clone-name" hint="Lowercase identifier, unique in your organization." error={errors.name?.message} required>
        <Input id="clone-name" className="font-mono" autoFocus {...describedBy('clone-name', { hint: true, error: errors.name })} {...form.register('name')} />
      </Field>
      <Field label="Display name" htmlFor="clone-display" error={errors.displayName?.message} required>
        <Input id="clone-display" {...describedBy('clone-display', { error: errors.displayName })} {...form.register('displayName')} />
      </Field>
      {clone.error ? <ErrorNotice error={clone.error} /> : null}
      <div className="flex justify-end gap-2 border-t border-border pt-3">
        <Button onClick={onDone}>Cancel</Button>
        <Button type="submit" variant="primary" loading={clone.isPending}>
          Clone template
        </Button>
      </div>
    </form>
  );
}
