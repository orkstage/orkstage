'use client';

import dynamic from 'next/dynamic';
import { useTranslations } from 'use-intl';
import { PageSpinner } from '@/components/ui/spinner';
import { useCan } from '@/lib/ability';

const TemplateBuilder = dynamic(() => import('@/components/builder/builder'), { ssr: false, loading: () => <BuilderLoading /> });

function BuilderLoading() {
  const t = useTranslations('templates');
  return <PageSpinner label={t('openingBuilder')} />;
}

export default function NewTemplateBuilderPage() {
  const t = useTranslations('templates');
  const can = useCan();
  const mayCreate = can('create', 'Template');
  return (
    <TemplateBuilder
      template={null}
      baseVersion={null}
      initialSource={null}
      readOnly={!mayCreate}
      readOnlyReason={mayCreate ? undefined : t('readOnlyNoCreate')}
      canClone={false}
      canPublish={can('publish', 'Template')}
    />
  );
}
