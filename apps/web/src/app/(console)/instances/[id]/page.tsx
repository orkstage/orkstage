'use client';

import type { InstanceDto, PreviewDto } from '@co/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ClipboardCheck, FileSearch, Rocket, Trash2, ArrowUpCircle } from 'lucide-react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { DeploymentsList } from '@/components/deployments-table';
import { DeployDialog, DestroyDialog, UpgradeDialog } from '@/components/instance/action-dialogs';
import { LogsPanel, MetricsPanel } from '@/components/instance/telemetry';
import { Topology } from '@/components/instance/topology';
import { PreviewReport } from '@/components/plan-view';
import { Badge, SimulatedBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorNotice, Notice } from '@/components/ui/error-notice';
import { Disclosure, KeyValues, PageHeader } from '@/components/ui/page-header';
import { PageSpinner } from '@/components/ui/spinner';
import { StatusBadge } from '@/components/ui/status-badge';
import { TabPanel, Tabs } from '@/components/ui/tabs';
import { apiGet, apiSend } from '@/lib/api';
import { useCan } from '@/lib/ability';
import { isDeploymentActive, isInstanceTransitional } from '@/lib/status';
import { formatDateTime, formatRelative, shortId } from '@/lib/utils';

type TabId = 'overview' | 'plan' | 'deployments' | 'logs' | 'metrics';
const TABS: { id: TabId; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'plan', label: 'Plan & cost' },
  { id: 'deployments', label: 'Deployments' },
  { id: 'logs', label: 'Logs' },
  { id: 'metrics', label: 'Metrics' },
];

export default function InstancePage() {
  return (
    <Suspense fallback={<PageSpinner />}>
      <InstanceView />
    </Suspense>
  );
}

function InstanceView() {
  const { id } = useParams<{ id: string }>();
  const search = useSearchParams();
  const initialTab = TABS.some((t) => t.id === search.get('tab')) ? (search.get('tab') as TabId) : 'overview';
  const [tab, setTab] = useState<TabId>(initialTab);
  const [dialog, setDialog] = useState<'deploy' | 'destroy' | 'upgrade' | null>(null);
  const [upgradedTo, setUpgradedTo] = useState<string | null>(null);
  const can = useCan();

  const q = useQuery({
    queryKey: ['instance', id],
    queryFn: ({ signal }) => apiGet<InstanceDto>(`/instances/${id}`, { signal }),
    refetchInterval: (query) => {
      const d = query.state.data;
      return d && (isInstanceTransitional(d.status) || isDeploymentActive(d.lastDeployment?.status)) ? 3000 : 15_000;
    },
  });

  const preview = useMutation({
    mutationFn: () => apiSend<PreviewDto>('POST', `/instances/${id}/preview`),
  });

  // Coming from the creation wizard: run the first preview automatically.
  const autoPreviewed = useRef(false);
  const hasData = !!q.data;
  const { mutate: runPreviewMutation } = preview;
  useEffect(() => {
    if (initialTab !== 'plan' || !hasData || autoPreviewed.current) return;
    autoPreviewed.current = true;
    runPreviewMutation();
  }, [initialTab, hasData, runPreviewMutation]);

  if (q.isPending) return <PageSpinner />;
  if (q.error) return <ErrorNotice error={q.error} title="Instance unavailable" />;
  const inst = q.data;

  const canDeploy = can('deploy', 'Instance', inst.tenantId);
  const canDestroy = can('destroy', 'Instance', inst.tenantId);
  const canUpdate = can('update', 'Instance', inst.tenantId);
  const busy = isDeploymentActive(inst.lastDeployment?.status) || isInstanceTransitional(inst.status);
  const destroyed = inst.status === 'DESTROYED';
  const resources = inst.resources ?? [];

  const runPreview = () => {
    setTab('plan');
    preview.mutate();
  };

  return (
    <>
      <PageHeader
        breadcrumb={
          <>
            <Link href="/instances" className="hover:underline">
              Instances
            </Link>{' '}
            / <span className="font-mono">{inst.slug}</span>
          </>
        }
        title={inst.name}
        description={
          <>
            {inst.tenantName} · {inst.template.displayName} <span className="font-mono text-xs">@{inst.template.version}</span> · {inst.environment}
          </>
        }
        meta={
          <>
            <StatusBadge status={inst.status} prefix="Status" />
            <StatusBadge status={inst.health} prefix="Health" />
            {inst.simulated ? <SimulatedBadge /> : null}
            {inst.protectedFromDestroy ? <Badge tone="info">Destroy protected</Badge> : null}
            {inst.lastDeployment ? (
              <Link href={`/deployments/${inst.lastDeployment.id}`} className="text-xs text-fg-subtle hover:text-accent-ink hover:underline">
                Last deployment {inst.lastDeployment.kind.toLowerCase()} · {inst.lastDeployment.status.toLowerCase().replace(/_/g, ' ')} · {formatRelative(inst.lastDeployment.queuedAt)}
              </Link>
            ) : null}
          </>
        }
        actions={
          <>
            {canDeploy || canUpdate ? (
              <Button onClick={runPreview} loading={preview.isPending} disabled={destroyed}>
                <FileSearch size={14} aria-hidden /> Preview
              </Button>
            ) : null}
            {canUpdate ? (
              <Button onClick={() => setDialog('upgrade')} disabled={busy || destroyed}>
                <ArrowUpCircle size={14} aria-hidden /> Upgrade template
              </Button>
            ) : null}
            {canDeploy ? (
              <Button variant="primary" onClick={() => setDialog('deploy')} disabled={busy || destroyed} title={busy ? 'A deployment is already in progress' : undefined}>
                <Rocket size={14} aria-hidden /> Deploy
              </Button>
            ) : null}
            {canDestroy ? (
              <Button variant="danger-outline" onClick={() => setDialog('destroy')} disabled={busy || destroyed}>
                <Trash2 size={14} aria-hidden /> Destroy
              </Button>
            ) : null}
          </>
        }
      />

      {inst.lastDeployment && isDeploymentActive(inst.lastDeployment.status) ? (
        <Notice tone="info" className="mb-4">
          A {inst.lastDeployment.kind.toLowerCase()} deployment is {inst.lastDeployment.status.toLowerCase().replace(/_/g, ' ')}.{' '}
          <Link href={`/deployments/${inst.lastDeployment.id}`} className="font-medium text-accent-ink underline">
            Follow progress
          </Link>
        </Notice>
      ) : null}
      {upgradedTo !== null ? (
        <Notice tone="ok" className="mb-4">
          Template version changed{upgradedTo ? ` to ${upgradedTo}` : ''}. Run a preview to review the changes, then deploy to apply them.
        </Notice>
      ) : null}

      <Tabs tabs={TABS} value={tab} onChange={setTab} label="Instance sections" idPrefix="inst" />

      {tab === 'overview' ? (
        <TabPanel id="overview" idPrefix="inst">
          <div className="grid gap-4 xl:grid-cols-[1fr_20rem]">
            <Card>
              <CardHeader title="Topology" description="Grouped by provider, cloud target and region. Knowledge: DESIRED (planned) → KNOWN (recorded) → ACTUAL (observed)." />
              <CardBody>
                <Topology instance={inst} canSimulate={canDeploy || canUpdate} connectivity={preview.data?.connectivity} />
              </CardBody>
            </Card>
            <div className="space-y-4">
              <Card>
                <CardHeader title="Details" as="h3" />
                <CardBody>
                  <KeyValues
                    items={[
                      { label: 'Slug', value: <code className="font-mono text-xs">{inst.slug}</code> },
                      { label: 'Tenant', value: inst.tenantName },
                      { label: 'Environment', value: inst.environment },
                      { label: 'Template', value: `${inst.template.displayName} @${inst.template.version}` },
                      { label: 'Created', value: formatDateTime(inst.createdAt) },
                      { label: 'Updated', value: formatDateTime(inst.updatedAt) },
                      { label: 'Id', value: <code className="font-mono text-xs" title={inst.id}>{shortId(inst.id)}</code> },
                    ]}
                  />
                </CardBody>
              </Card>
              <Card>
                <CardHeader title="Placement" as="h3" />
                <CardBody>
                  <ul className="space-y-1 text-sm">
                    {Object.entries(inst.bindings).map(([slot, b]) => (
                      <li key={slot} className="flex justify-between gap-2">
                        <span className="font-mono text-xs text-fg-subtle">{slot}</span>
                        <span className="font-mono text-xs">
                          {shortId(b.targetId)} / {b.region}
                        </span>
                      </li>
                    ))}
                  </ul>
                </CardBody>
              </Card>
              {Object.keys(inst.variables).length > 0 ? (
                <Disclosure summary={`Variables (${Object.keys(inst.variables).length})`} className="bg-surface">
                  <KeyValues items={Object.entries(inst.variables).map(([k, v]) => ({ label: <span className="font-mono text-xs">{k}</span>, value: String(v) }))} />
                </Disclosure>
              ) : null}
            </div>
          </div>
        </TabPanel>
      ) : null}

      {tab === 'plan' ? (
        <TabPanel id="plan" idPrefix="inst">
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <Button onClick={() => preview.mutate()} loading={preview.isPending} disabled={destroyed || !(canDeploy || canUpdate)}>
              <ClipboardCheck size={14} aria-hidden /> {preview.data ? 'Re-run preview' : 'Run preview'}
            </Button>
            {canDeploy ? (
              <Button variant="primary" onClick={() => setDialog('deploy')} disabled={busy || destroyed || (preview.data ? !preview.data.valid : false)}>
                <Rocket size={14} aria-hidden /> Deploy
              </Button>
            ) : null}
            <span className="text-xs text-fg-subtle">Preview compiles the template, checks policies, estimates cost and computes the plan. Nothing is changed.</span>
          </div>
          {preview.error ? <ErrorNotice error={preview.error} title="Preview failed" className="mb-4" /> : null}
          {preview.data ? (
            <PreviewReport preview={preview.data} />
          ) : preview.isPending ? (
            <PageSpinner label="Compiling and planning" />
          ) : (
            <Card>
              <EmptyState icon={FileSearch} title="No preview yet" description="Run a preview to see validation issues, policy results, connectivity, cost and the change plan." />
            </Card>
          )}
        </TabPanel>
      ) : null}

      {tab === 'deployments' ? (
        <TabPanel id="deployments" idPrefix="inst">
          <Card>
            <DeploymentsList basePath={`/instances/${inst.id}/deployments`} showInstance={false} />
          </Card>
        </TabPanel>
      ) : null}

      {tab === 'logs' ? (
        <TabPanel id="logs" idPrefix="inst">
          <Card>
            <CardBody>
              <LogsPanel instanceId={inst.id} resources={resources} />
            </CardBody>
          </Card>
        </TabPanel>
      ) : null}

      {tab === 'metrics' ? (
        <TabPanel id="metrics" idPrefix="inst">
          <Card>
            <CardBody>
              <MetricsPanel instanceId={inst.id} resources={resources} />
            </CardBody>
          </Card>
        </TabPanel>
      ) : null}

      <DeployDialog instance={inst} open={dialog === 'deploy'} onClose={() => setDialog(null)} />
      <DestroyDialog instance={inst} open={dialog === 'destroy'} onClose={() => setDialog(null)} />
      <UpgradeDialog
        instance={inst}
        open={dialog === 'upgrade'}
        onClose={() => setDialog(null)}
        onUpgraded={(v) => {
          setUpgradedTo(v);
          preview.reset();
          setTab('plan');
        }}
      />
    </>
  );
}
