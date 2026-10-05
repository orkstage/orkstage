'use client';

import dynamic from 'next/dynamic';
import { PageSpinner } from '@/components/ui/spinner';
import { useCan } from '@/lib/ability';

const TemplateBuilder = dynamic(() => import('@/components/builder/builder'), { ssr: false, loading: () => <PageSpinner label="Opening the builder" /> });

export default function NewTemplateBuilderPage() {
  const can = useCan();
  const mayCreate = can('create', 'Template');
  return (
    <TemplateBuilder
      template={null}
      baseVersion={null}
      initialSource={null}
      readOnly={!mayCreate}
      readOnlyReason={mayCreate ? undefined : 'You do not have permission to create templates.'}
      canClone={false}
      canPublish={can('publish', 'Template')}
    />
  );
}
