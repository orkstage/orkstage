'use client';

import { FileCode2, Plus } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'use-intl';
import { useFormat } from '@/i18n/format';
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

export default function TemplatesPage() {
  const t = useTranslations('templates');
  const fmt = useFormat();
  const templates = useTemplates();
  const can = useCan();
  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          can('create', 'Template') ? (
            <div className="flex gap-2">
              <ButtonLink href="/templates/import">{t('import')}</ButtonLink>
              <ButtonLink href="/templates/new" variant="primary">
                <Plus size={14} aria-hidden /> {t('new')}
              </ButtonLink>
            </div>
          ) : null
        }
      />
      <Card>
        {templates.isPending ? (
          <PageSpinner />
        ) : templates.error ? (
          <ErrorNotice error={templates.error} className="m-4" />
        ) : templates.data.length === 0 ? (
          <EmptyState icon={FileCode2} title={t('emptyTitle')} description={t('emptyBody')} />
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>{t('table.template')}</TH>
                <TH>{t('table.visibility')}</TH>
                <TH>{t('table.latest')}</TH>
                <TH>{t('table.plans')}</TH>
                <TH>{t('table.profile')}</TH>
                <TH>{t('table.published')}</TH>
              </tr>
            </THead>
            <TBody>
              {templates.data.map((tpl) => {
                const doc = tpl.latestPublished ? readTemplateDoc(tpl.latestPublished.document) : null;
                return (
                  <TR key={tpl.id}>
                    <TD>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Link href={`/templates/${tpl.id}`} className="font-medium hover:text-accent-ink hover:underline">
                          {tpl.displayName}
                        </Link>
                        {doc?.nonProduction ? <Badge tone="warn">{t('nonProduction')}</Badge> : null}
                      </div>
                      <code className="font-mono text-[11px] text-fg-subtle">{tpl.name}</code>
                      {tpl.description ? <p className="mt-0.5 line-clamp-1 max-w-md text-xs text-fg-muted">{tpl.description}</p> : null}
                    </TD>
                    <TD>{tpl.visibility === 'SYSTEM' ? <Badge tone="info">{t('system')}</Badge> : <Badge>{t('organization')}</Badge>}</TD>
                    <TD>
                      {tpl.latestPublished ? (
                        <span className="flex items-center gap-1.5">
                          <code className="font-mono text-xs">{tpl.latestPublished.version}</code>
                          <StatusBadge status={tpl.latestPublished.status} />
                        </span>
                      ) : (
                        <span className="text-xs text-fg-subtle">{t('draftOnly')}</span>
                      )}
                    </TD>
                    <TD>
                      <div className="flex flex-wrap gap-1">
                        {(doc?.plans ?? []).map((p) => (
                          <Badge key={p}>{p}</Badge>
                        ))}
                      </div>
                    </TD>
                    <TD className="text-xs text-fg-muted">{doc?.profile ?? fmt.empty}</TD>
                    <TD className="whitespace-nowrap text-xs text-fg-muted">{fmt.dateTime(tpl.latestPublished?.publishedAt)}</TD>
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
