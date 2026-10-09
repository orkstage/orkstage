'use client';

import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { DeploymentsList } from '@/components/deployments-table';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { Select } from '@/components/ui/select';
import { useStatusLabel } from '@/i18n/labels';

const STATUSES = ['QUEUED', 'RUNNING', 'AWAITING_APPROVAL', 'SUCCEEDED', 'FAILED', 'PARTIALLY_FAILED', 'CANCELLED'];

export default function DeploymentsPage() {
  const t = useTranslations('deployments');
  const statusLabel = useStatusLabel();
  const [status, setStatus] = useState('');
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <div className="mb-3">
        <label htmlFor="dep-status" className="mb-1 block text-xs text-fg-subtle">
          {t('status')}
        </label>
        <Select id="dep-status" value={status} onChange={(e) => setStatus(e.target.value)} className="w-52">
          <option value="">{t('anyStatus')}</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {statusLabel(s)}
            </option>
          ))}
        </Select>
      </div>
      <Card>
        <DeploymentsList basePath="/deployments" params={{ status: status || undefined }} />
      </Card>
    </>
  );
}
