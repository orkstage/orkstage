'use client';

import dynamic from 'next/dynamic';
import { useParams, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { useTranslations } from 'use-intl';
import { ErrorNotice } from '@/components/ui/error-notice';
import { PageSpinner } from '@/components/ui/spinner';
import { useCan } from '@/lib/ability';
import { useTemplate } from '@/lib/queries';

// React Flow, yaml and the template schema load only on the builder route.
const TemplateBuilder = dynamic(() => import('@/components/builder/builder'), { ssr: false, loading: () => <BuilderLoading /> });

function BuilderLoading() {
  const t = useTranslations('templates');
  return <PageSpinner label={t('openingBuilder')} />;
}

export default function TemplateBuilderPage() {
  return (
    <Suspense fallback={<PageSpinner />}>
      <BuilderRoute />
    </Suspense>
  );
}

function BuilderRoute() {
  const tt = useTranslations('templates');
  const { id } = useParams<{ id: string }>();
  const versionParam = useSearchParams().get('version');
  const can = useCan();
  const q = useTemplate(id);

  if (q.isPending) return <PageSpinner />;
  if (q.error) return <ErrorNotice error={q.error} title={tt('unavailable')} />;
  const t = q.data;
  const versions = [...(t.versions ?? (t.latestPublished ? [t.latestPublished] : []))].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const base = versions.find((v) => v.id === versionParam) ?? versions[0] ?? null;

  const system = t.visibility === 'SYSTEM';
  const mayEdit = can('update', 'Template');
  const readOnly = system || !mayEdit;
  const reason = system ? tt('readOnlySystem') : !mayEdit ? tt('readOnlyNoEdit') : undefined;

  return (
    <TemplateBuilder
      key={`${t.id}:${base?.id ?? 'none'}`}
      template={t}
      baseVersion={base}
      initialSource={base?.source ?? null}
      readOnly={readOnly}
      readOnlyReason={reason}
      canClone={can('create', 'Template')}
      canPublish={can('publish', 'Template')}
    />
  );
}
