'use client';

import { useState } from 'react';
import { DeploymentsList } from '@/components/deployments-table';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { Select } from '@/components/ui/select';

const STATUSES = ['QUEUED', 'RUNNING', 'AWAITING_APPROVAL', 'SUCCEEDED', 'FAILED', 'PARTIALLY_FAILED', 'CANCELLED'];

export default function DeploymentsPage() {
  const [status, setStatus] = useState('');
  return (
    <>
      <PageHeader title="Deployments" description="Every rollout and teardown across your fleet, newest first. Open one to watch it step by step." />
      <div className="mb-3">
        <label htmlFor="dep-status" className="mb-1 block text-xs text-fg-subtle">
          Status
        </label>
        <Select id="dep-status" value={status} onChange={(e) => setStatus(e.target.value)} className="w-52">
          <option value="">Any status</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s.replace(/_/g, ' ').toLowerCase()}
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
