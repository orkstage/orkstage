'use client';

import type { InstanceDto, PreviewDto } from '@co/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ClipboardCheck, FileSearch, Rocket, Trash2, ArrowUpCircle } from 'lucide-react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
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
import { useFormat } from '@/i18n/format';
import { useEnvironmentLabel, useStatusLabel } from '@/i18n/labels';
import { useDocumentTitle } from '@/lib/hooks';
import { shortId } from '@/lib/utils';

type TabId = 'overview' | 'plan' | 'deployments' | 'logs' | 'metrics';
const TAB_IDS: TabId[] = ['overview', 'plan', 'deployments', 'logs', 'metrics'];

export default function InstancePage() {
  return (
    <Suspense fallback={<PageSpinner />}>
      <InstanceView />
    </Suspense>
  );
}

function InstanceView() {
  const t = useTranslations('instance');
  const tk = useTranslations('deployments.kind');
  const fmt = useFormat();
  const statusLabel = useStatusLabel();
  const envLabel = useEnvironmentLabel();
  const { id } = useParams<{ id: string }>();
  const search = useSearchParams();
  const initialTab = TAB_IDS.includes(search.get('tab') as TabId) ? (search.get('tab') as TabId) : 'overview';
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

  useDocumentTitle(q.data?.name);

  if (q.isPending) return <PageSpinner />;
  if (q.error) return <ErrorNotice error={q.error} title={t('unavailable')} />;
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
              {t('breadcrumb')}
            </Link>{' '}
            / <span className="font-mono">{inst.slug}</span>
          </>
        }
        title={inst.name}
        description={
          <>
            {inst.tenantName} · {inst.template.displayName} <span className="font-mono text-xs">@{inst.template.version}</span> · {envLabel(inst.environment)}
          </>
        }
        meta={
          <>
            <StatusBadge status={inst.status} prefix={t('statusPrefix')} />
            <StatusBadge status={inst.health} prefix={t('healthPrefix')} />
            {inst.simulated ? <SimulatedBadge /> : null}
            {inst.protectedFromDestroy ? <Badge tone="info">{t('destroyProtected')}</Badge> : null}
            {inst.lastDeployment ? (
              <Link href={`/deployments/${inst.lastDeployment.id}`} className="text-xs text-fg-subtle hover:text-accent-ink hover:underline">
                {t('lastDeployment', {
                  kind: tk(inst.lastDeployment.kind),
                  status: statusLabel(inst.lastDeployment.status),
                  when: fmt.relative(inst.lastDeployment.queuedAt),
                })}
              </Link>
            ) : null}
          </>
        }
        actions={
          <>
            {canDeploy || canUpdate ? (
              <Button onClick={runPreview} loading={preview.isPending} disabled={destroyed}>
                <FileSearch size={14} aria-hidden /> {t('preview')}
              </Button>
            ) : null}
            {canUpdate ? (
              <Button onClick={() => setDialog('upgrade')} disabled={busy || destroyed}>
                <ArrowUpCircle size={14} aria-hidden /> {t('upgrade')}
              </Button>
            ) : null}
            {canDeploy ? (
              <Button variant="primary" onClick={() => setDialog('deploy')} disabled={busy || destroyed} title={busy ? t('deployBusy') : undefined}>
                <Rocket size={14} aria-hidden /> {t('deploy')}
              </Button>
            ) : null}
            {canDestroy ? (
              <Button variant="danger-outline" onClick={() => setDialog('destroy')} disabled={busy || destroyed}>
                <Trash2 size={14} aria-hidden /> {t('destroy')}
              </Button>
            ) : null}
          </>
        }
      />

      {inst.lastDeployment && isDeploymentActive(inst.lastDeployment.status) ? (
        <Notice tone="info" className="mb-4">
          {t('activeDeployment', { kind: tk(inst.lastDeployment.kind), status: statusLabel(inst.lastDeployment.status).toLowerCase() })}{' '}
          <Link href={`/deployments/${inst.lastDeployment.id}`} className="font-medium text-accent-ink underline">
            {t('followProgress')}
          </Link>
        </Notice>
      ) : null}
      {upgradedTo !== null ? (
        <Notice tone="ok" className="mb-4">
          {upgradedTo ? t('upgradedTo', { version: upgradedTo }) : t('upgraded')}
        </Notice>
      ) : null}

      <Tabs tabs={TAB_IDS.map((tabId) => ({ id: tabId, label: t(`tabs.${tabId}`) }))} value={tab} onChange={setTab} label={t('tabs.label')} idPrefix="inst" />

      {tab === 'overview' ? (
        <TabPanel id="overview" idPrefix="inst">
          <div className="grid gap-4 xl:grid-cols-[1fr_20rem]">
            <Card>
              <CardHeader title={t('topology')} description={t('topologyHint')} />
              <CardBody>
                <Topology instance={inst} canSimulate={canDeploy || canUpdate} connectivity={preview.data?.connectivity} />
              </CardBody>
            </Card>
            <div className="space-y-4">
              <Card>
                <CardHeader title={t('details')} as="h3" />
                <CardBody>
                  <KeyValues
                    items={[
                      { label: t('fields.slug'), value: <code className="font-mono text-xs">{inst.slug}</code> },
                      { label: t('fields.tenant'), value: inst.tenantName },
                      { label: t('fields.environment'), value: envLabel(inst.environment) },
                      { label: t('fields.template'), value: `${inst.template.displayName} @${inst.template.version}` },
                      { label: t('fields.created'), value: fmt.dateTime(inst.createdAt) },
                      { label: t('fields.updated'), value: fmt.dateTime(inst.updatedAt) },
                      { label: t('fields.id'), value: <code className="font-mono text-xs" title={inst.id}>{shortId(inst.id)}</code> },
                    ]}
                  />
                </CardBody>
              </Card>
              <Card>
                <CardHeader title={t('placement')} as="h3" />
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
                <Disclosure summary={t('variables', { count: Object.keys(inst.variables).length })} className="bg-surface">
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
              <ClipboardCheck size={14} aria-hidden /> {preview.data ? t('rerunPreview') : t('runPreview')}
            </Button>
            {canDeploy ? (
              <Button variant="primary" onClick={() => setDialog('deploy')} disabled={busy || destroyed || (preview.data ? !preview.data.valid : false)}>
                <Rocket size={14} aria-hidden /> {t('deploy')}
              </Button>
            ) : null}
            <span className="text-xs text-fg-subtle">{t('previewHint')}</span>
          </div>
          {preview.error ? <ErrorNotice error={preview.error} title={t('previewFailed')} className="mb-4" /> : null}
          {preview.data ? (
            <PreviewReport preview={preview.data} />
          ) : preview.isPending ? (
            <PageSpinner label={t('planning')} />
          ) : (
            <Card>
              <EmptyState icon={FileSearch} title={t('noPreviewTitle')} description={t('noPreviewBody')} />
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
