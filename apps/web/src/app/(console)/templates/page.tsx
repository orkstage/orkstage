'use client';

import { FileCode2, Plus } from 'lucide-react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorNotice } from '@/components/ui/error-notice';
import { PageHeader } from '@/components/ui/page-header';
import { PageSpinner } from '@/components/ui/spinner';
import { StatusBadge } from '@/components/ui/status-badge';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useCan } from '@/lib/ability';
import { useTemplates } from '@/lib/queries';
import { readTemplateDoc } from '@/lib/template-doc';
import { formatDateTime } from '@/lib/utils';

export default function TemplatesPage() {
  const templates = useTemplates();
  const can = useCan();
  return (
    <>
      <PageHeader
        title="Templates"
        description="Templates are forged once, deployed many times. Published versions never change; each instance pins the version it runs."
        actions={
          can('create', 'Template') ? (
            <ButtonLink href="/templates/new" variant="primary">
              <Plus size={14} aria-hidden /> New template
            </ButtonLink>
          ) : null
        }
      />
      <Card>
        {templates.isPending ? (
          <PageSpinner />
        ) : templates.error ? (
          <ErrorNotice error={templates.error} className="m-4" />
        ) : templates.data.length === 0 ? (
          <EmptyState icon={FileCode2} title="Nothing forged yet" description="System templates ship with the platform. Create a template, or clone one to make it your own." />
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>Template</TH>
                <TH>Visibility</TH>
                <TH>Latest published</TH>
                <TH>Plans</TH>
                <TH>Profile</TH>
                <TH>Published</TH>
              </tr>
            </THead>
            <TBody>
              {templates.data.map((t) => {
                const doc = t.latestPublished ? readTemplateDoc(t.latestPublished.document) : null;
                return (
                  <TR key={t.id}>
                    <TD>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Link href={`/templates/${t.id}`} className="font-medium hover:text-accent-ink hover:underline">
                          {t.displayName}
                        </Link>
                        {doc?.nonProduction ? <Badge tone="warn">Non-production</Badge> : null}
                      </div>
                      <code className="font-mono text-[11px] text-fg-subtle">{t.name}</code>
                      {t.description ? <p className="mt-0.5 line-clamp-1 max-w-md text-xs text-fg-muted">{t.description}</p> : null}
                    </TD>
                    <TD>{t.visibility === 'SYSTEM' ? <Badge tone="info">System</Badge> : <Badge>Organization</Badge>}</TD>
                    <TD>
                      {t.latestPublished ? (
                        <span className="flex items-center gap-1.5">
                          <code className="font-mono text-xs">{t.latestPublished.version}</code>
                          <StatusBadge status={t.latestPublished.status} />
                        </span>
                      ) : (
                        <span className="text-xs text-fg-subtle">Draft only</span>
                      )}
                    </TD>
                    <TD>
                      <div className="flex flex-wrap gap-1">
                        {(doc?.plans ?? []).map((p) => (
                          <Badge key={p}>{p}</Badge>
                        ))}
                      </div>
                    </TD>
                    <TD className="text-xs text-fg-muted">{doc?.profile ?? '—'}</TD>
                    <TD className="whitespace-nowrap text-xs text-fg-muted">{formatDateTime(t.latestPublished?.publishedAt)}</TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        )}
      </Card>
    </>
  );
}
