'use client';

import type { ImportDto, ScanReport } from '@co/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { FileUp, Import } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useId, useState, type ChangeEvent } from 'react';
import { useTranslations } from 'use-intl';
import { useStatusLabel } from '@/i18n/labels';
import { YamlViewer } from '@/components/yaml-viewer';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ErrorNotice, Notice } from '@/components/ui/error-notice';
import { Field, Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { PageSpinner } from '@/components/ui/spinner';
import { apiGet, apiSend } from '@/lib/api';
import { useCan } from '@/lib/ability';
import { slugify } from '@/lib/utils';

/** Text files the scan engine understands; everything else is skipped in the browser. */
const ACCEPT = /\.(tf|tf\.json|ya?ml|json|toml|txt|gradle|kts|xml|bicep|lock)$|(^|\/)(Dockerfile|Gemfile|go\.mod|requirements\.txt|package\.json|composer\.json|Chart\.yaml)$/i;
const SKIP_DIRS = /(^|\/)(node_modules|\.git|\.terraform|target|vendor|dist|build|\.next)\//;
const MAX_FILE = 512 * 1024;
const MAX_TOTAL = 5 * 1024 * 1024;

const confidenceTone = { high: 'ok', medium: 'info', low: 'neutral' } as const;

export default function ImportPage() {
  return (
    <Suspense fallback={<PageSpinner />}>
      <ImportView />
    </Suspense>
  );
}

function ImportView() {
  const t = useTranslations('importPage');
  const statusLabel = useStatusLabel();
  const id = useId();
  const router = useRouter();
  const can = useCan();
  const [files, setFiles] = useState<{ path: string; content: string }[]>([]);
  const [skipped, setSkipped] = useState(0);
  const [reportJson, setReportJson] = useState('');
  const [result, setResult] = useState<ImportDto | null>(null);
  const [name, setName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [jsonError, setJsonError] = useState(false);

  const show = (r: ImportDto) => {
    setResult(r);
    const base = r.report.template.match(/name:\s*([a-z0-9-]+)/)?.[1] ?? 'imported';
    setName(slugify(`${base}-imported`));
    setDisplayName(t('defaultDisplayName'));
  };
  const run = useMutation({
    mutationFn: (body: unknown) => apiSend<ImportDto>('POST', '/imports', body),
    onSuccess: show,
  });
  // `ork import` links here with ?importId=<id> so a scan made locally opens straight in review.
  const importId = useSearchParams().get('importId');
  const linked = useQuery({ queryKey: ['import', importId], queryFn: () => apiGet<ImportDto>(`/imports/${importId}`), enabled: Boolean(importId) });
  useEffect(() => {
    if (linked.data) show(linked.data);
  }, [linked.data]);
  const toTemplate = useMutation({
    mutationFn: () => apiSend<{ templateId: string }>('POST', `/imports/${result!.id}/template`, { name, displayName }),
    onSuccess: (r) => router.push(`/templates/${r.templateId}/builder`),
  });

  const onFiles = async (e: ChangeEvent<HTMLInputElement>) => {
    const list = Array.from(e.target.files ?? []);
    const picked: { path: string; content: string }[] = [];
    let total = 0;
    let skip = 0;
    for (const f of list) {
      const path = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
      if (SKIP_DIRS.test(path) || !ACCEPT.test(path) || f.size > MAX_FILE || total + f.size > MAX_TOTAL) {
        skip++;
        continue;
      }
      total += f.size;
      picked.push({ path, content: await f.text() });
    }
    setFiles(picked);
    setSkipped(skip);
  };

  const report: ScanReport | undefined = result?.report;
  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
      />

      {!result ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card className="space-y-3 p-4">
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <FileUp size={15} aria-hidden /> {t('uploadTitle')}
            </h2>
            <p className="text-sm text-fg-muted">{t('uploadHint')}</p>
            <Input
              type="file"
              multiple
              aria-label={t('folder')}
              onChange={onFiles}
              {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
            />
            {files.length > 0 ? (
              <p className="text-xs text-fg-subtle">
                {skipped ? t('selectedSkipped', { count: files.length, skipped }) : `${t('selected', { count: files.length })}.`}
              </p>
            ) : null}
            <Button variant="primary" disabled={files.length === 0} loading={run.isPending && !!files.length} onClick={() => run.mutate({ files })}>
              {t('scan')}
            </Button>
          </Card>
          <Card className="space-y-3 p-4">
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <Import size={15} aria-hidden /> {t('pasteTitle')}
            </h2>
            <p className="text-sm text-fg-muted">{t.rich('pasteHint', { code: (chunks) => <code className="font-mono text-xs">{chunks}</code> })}</p>
            <Textarea
              rows={7}
              aria-label={t('reportLabel')}
              aria-invalid={jsonError || undefined}
              value={reportJson}
              onChange={(e) => {
                setReportJson(e.target.value);
                setJsonError(false);
              }}
              className="font-mono text-xs"
              placeholder='{ "version": 1 }'
            />
            {jsonError ? (
              <p role="alert" className="text-xs text-danger-ink">
                {t('invalidJson')}
              </p>
            ) : null}
            <Button
              variant="primary"
              disabled={!reportJson.trim()}
              onClick={() => {
                try {
                  run.mutate({ report: JSON.parse(reportJson) });
                } catch {
                  run.reset();
                  setJsonError(true);
                }
              }}
            >
              {t('importReport')}
            </Button>
          </Card>
          {run.error ? <ErrorNotice error={run.error} className="lg:col-span-2" /> : null}
          {linked.error ? <ErrorNotice error={linked.error} className="lg:col-span-2" /> : null}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {result.sourceKinds.map((k) => (
              <Badge key={k} tone="info">
                {k}
              </Badge>
            ))}
            {result.validation.valid ? <Badge tone="ok">{t('templateValid')}</Badge> : <Badge tone="warn">{t('needsReview')}</Badge>}
          </div>

          <Card>
            <h2 className="border-b border-border px-4 py-3 text-sm font-semibold">{t('detected', { count: report!.resources.length })}</h2>
            <Table>
              <THead>
                <tr>
                  <TH>{t('table.resource')}</TH>
                  <TH>{t('table.type')}</TH>
                  <TH>{t('table.provider')}</TH>
                  <TH>{t('table.confidence')}</TH>
                  <TH>{t('table.evidence')}</TH>
                </tr>
              </THead>
              <TBody>
                {report!.resources.map((r) => (
                  <TR key={r.id}>
                    <TD className="font-medium">{r.id}</TD>
                    <TD>
                      <code className="font-mono text-xs">{r.type}</code>
                      {r.implementation ? <span className="text-[11px] text-fg-subtle"> · {r.implementation}</span> : null}
                    </TD>
                    <TD className="text-xs">{r.provider ?? <span className="text-fg-subtle">{t('anyProvider')}</span>}</TD>
                    <TD>
                      <Badge tone={confidenceTone[r.confidence]}>{statusLabel(r.confidence)}</Badge>
                    </TD>
                    <TD className="max-w-96 text-[11px] text-fg-subtle">
                      {r.sources.slice(0, 3).map((s) => (
                        <p key={`${s.file}:${s.address}`} className="truncate font-mono" title={`${s.file}${s.line ? `:${s.line}` : ''}`}>
                          {s.kind}: {s.address}
                        </p>
                      ))}
                      {r.sources.length > 3 ? <p>{t('more', { count: r.sources.length - 3 })}</p> : null}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </Card>

          {report!.unmapped.length > 0 ? (
            <Card className="p-4">
              <h2 className="mb-2 text-sm font-semibold">{t('notImported', { count: report!.unmapped.length })}</h2>
              <ul className="space-y-1 text-sm">
                {report!.unmapped.map((u) => (
                  <li key={`${u.source.file}:${u.source.address}`}>
                    <code className="font-mono text-xs">{u.source.address}</code> <span className="text-fg-subtle">({u.reason})</span>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          {report!.warnings.length > 0 || result.validation.issues.length > 0 ? (
            <Notice tone="warn">
              <ul className="list-inside list-disc space-y-0.5">
                {report!.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
                {result.validation.issues.map((i) => (
                  <li key={`${i.code}:${i.message}`}>
                    {i.message}
                    {i.path ? <span className="text-fg-subtle"> ({i.path})</span> : null}
                  </li>
                ))}
              </ul>
            </Notice>
          ) : null}

          <Card className="p-4">
            <h2 className="mb-2 text-sm font-semibold">{t('generated')}</h2>
            <YamlViewer source={report!.template} />
          </Card>

          {can('create', 'Template') ? (
            <Card className="space-y-3 p-4">
              <h2 className="text-sm font-semibold">{t('createDraft')}</h2>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t('name')} htmlFor={`${id}-name`} hint={t('nameHint')}>
                  <Input id={`${id}-name`} value={name} onChange={(e) => setName(slugify(e.target.value))} />
                </Field>
                <Field label={t('displayName')} htmlFor={`${id}-display`}>
                  <Input id={`${id}-display`} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
                </Field>
              </div>
              {toTemplate.error ? <ErrorNotice error={toTemplate.error} /> : null}
              <div className="flex gap-2">
                <Button variant="primary" loading={toTemplate.isPending} disabled={!name || !displayName} onClick={() => toTemplate.mutate()}>
                  {t('createAndOpen')}
                </Button>
                <Button onClick={() => setResult(null)}>{t('startOver')}</Button>
              </div>
            </Card>
          ) : (
            <Notice tone="info">{t('askAdmin', { id: result.id })}</Notice>
          )}
        </div>
      )}
    </>
  );
}
