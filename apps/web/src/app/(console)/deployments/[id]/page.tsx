'use client';

import type { DeploymentDto, DeploymentEventDto, DeploymentStepDto, DeploymentSummaryDto, Page } from '@co/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, Check, Circle, Redo2, RotateCcw, ShieldCheck, X, XCircle } from 'lucide-react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { CostTable, PlanGroups, PlanSummary } from '@/components/plan-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { CopyButton } from '@/components/ui/copy-button';
import { Dialog } from '@/components/ui/dialog';
import { ErrorNotice } from '@/components/ui/error-notice';
import { Disclosure, PageHeader } from '@/components/ui/page-header';
import { PageSpinner, Spinner } from '@/components/ui/spinner';
import { StatusBadge } from '@/components/ui/status-badge';
import { apiGet, apiSend, asItems, qs } from '@/lib/api';
import { useCan } from '@/lib/ability';
import { isDeploymentActive } from '@/lib/status';
import { useNow } from '@/lib/hooks';
import { cn, displayOutput, durationBetween, formatDateTime, formatDuration, formatTime, shortId } from '@/lib/utils';

const POLL_MS = 1500;

// ECharts is loaded only on this page, after the step data is known.
const DeploymentGantt = dynamic(() => import('@/components/charts/deployment-gantt'), { ssr: false, loading: () => <div className="h-24" /> });

/**
 * Incremental event stream: polls `/events?after=<lastId>` and appends only unseen events.
 * One extra fetch runs when the deployment turns terminal so the tail is never lost.
 */
function useDeploymentEvents(id: string, active: boolean) {
  const [events, setEvents] = useState<DeploymentEventDto[]>([]);
  const lastId = useRef<string | null>(null);
  const seen = useRef(new Set<string>());

  const q = useQuery({
    queryKey: ['deployment-events', id],
    queryFn: async ({ signal }) => {
      const data = await apiGet<DeploymentEventDto[] | Page<DeploymentEventDto>>(`/deployments/${id}/events${qs({ after: lastId.current })}`, { signal });
      const batch = [...asItems(data)].sort((a, b) => a.at.localeCompare(b.at));
      const fresh = batch.filter((e) => !seen.current.has(e.id));
      for (const e of fresh) seen.current.add(e.id);
      const tail = batch[batch.length - 1];
      if (tail) lastId.current = tail.id;
      if (fresh.length > 0) setEvents((prev) => [...prev, ...fresh]);
      return { seen: seen.current.size, lastId: lastId.current };
    },
    refetchInterval: active ? POLL_MS : false,
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
  });

  const wasActive = useRef(active);
  const { refetch } = q;
  useEffect(() => {
    if (wasActive.current && !active) void refetch();
    wasActive.current = active;
  }, [active, refetch]);

  return { events, error: q.error };
}

export default function DeploymentPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const can = useCan();
  const [confirmCancel, setConfirmCancel] = useState(false);

  const dep = useQuery({
    queryKey: ['deployment', id],
    queryFn: ({ signal }) => apiGet<DeploymentDto>(`/deployments/${id}`, { signal }),
    refetchInterval: (query) => (!query.state.data || isDeploymentActive(query.state.data.status) ? POLL_MS : false),
    refetchOnWindowFocus: false,
  });

  const active = isDeploymentActive(dep.data?.status);
  const { events, error: eventsError } = useDeploymentEvents(id, active);
  const now = useNow(active);

  const onAction = (d: DeploymentSummaryDto | DeploymentDto | undefined) => {
    void qc.invalidateQueries({ queryKey: ['deployment', id] });
    void qc.invalidateQueries({ queryKey: ['deployment-events', id] });
    void qc.invalidateQueries({ queryKey: ['deployments'] });
    if (d?.id && d.id !== id) router.push(`/deployments/${d.id}`);
  };
  const approve = useMutation({ mutationFn: () => apiSend<DeploymentSummaryDto>('POST', `/deployments/${id}/approve`), onSuccess: onAction });
  const cancel = useMutation({
    mutationFn: () => apiSend<DeploymentSummaryDto>('POST', `/deployments/${id}/cancel`),
    onSuccess: (d) => {
      setConfirmCancel(false);
      onAction(d);
    },
  });
  const retry = useMutation({ mutationFn: () => apiSend<DeploymentSummaryDto>('POST', `/deployments/${id}/retry`), onSuccess: onAction });

  if (dep.isPending) return <PageSpinner />;
  if (dep.error) return <ErrorNotice error={dep.error} title="Deployment unavailable" />;
  const d = dep.data;

  const steps = [...d.steps].sort((a, b) => a.position - b.position);
  const current = steps.find((s) => s.status === 'RUNNING') ?? null;
  const done = steps.filter((s) => s.status === 'SUCCEEDED' || s.status === 'SKIPPED').length;
  const failed = steps.filter((s) => s.status === 'FAILED').length;
  const elapsed = durationBetween(d.startedAt ?? d.queuedAt, d.finishedAt, now);
  const canDeploy = can('deploy', 'Instance', d.tenantId);
  const canApprove = can('approve', 'Instance', d.tenantId);
  const mutationError = approve.error ?? cancel.error ?? retry.error;

  return (
    <>
      {d.simulated ? (
        <div role="note" className="mb-4 rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-sm">
          <strong className="font-semibold uppercase tracking-wide text-accent-ink">Simulated</strong> — this deployment runs against the mock provider. No real cloud resources are created or changed.
        </div>
      ) : null}

      <PageHeader
        breadcrumb={
          <>
            <Link href="/deployments" className="hover:underline">
              Deployments
            </Link>{' '}
            / <span className="font-mono">{shortId(d.id)}</span>
          </>
        }
        title={
          <>
            {d.kind === 'DESTROY' ? 'Destroy' : 'Deploy'}{' '}
            <Link href={`/instances/${d.instanceId}`} className="hover:text-accent-ink hover:underline">
              {d.instanceName}
            </Link>
          </>
        }
        meta={
          <>
            <StatusBadge status={d.status} />
            <Badge tone={d.kind === 'DESTROY' ? 'danger' : 'neutral'}>{d.kind}</Badge>
            <span className="text-xs text-fg-subtle">
              Elapsed <span className="tabular-nums text-fg">{formatDuration(elapsed)}</span>
            </span>
            {current ? (
              <span className="flex items-center gap-1 text-xs text-info-ink">
                <Spinner size={11} /> {current.name}
              </span>
            ) : null}
            <span className="flex items-center gap-1 font-mono text-[11px] text-fg-subtle">
              correlation {d.correlationId} <CopyButton value={d.correlationId} label="Copy correlation id" />
            </span>
          </>
        }
        actions={
          <>
            {d.status === 'AWAITING_APPROVAL' && canApprove ? (
              <Button variant="primary" onClick={() => approve.mutate()} loading={approve.isPending}>
                <ShieldCheck size={14} aria-hidden /> Approve
              </Button>
            ) : null}
            {active && canDeploy ? (
              <Button variant="danger-outline" onClick={() => setConfirmCancel(true)}>
                <Ban size={14} aria-hidden /> Cancel
              </Button>
            ) : null}
            {(d.status === 'FAILED' || d.status === 'PARTIALLY_FAILED') && canDeploy ? (
              <Button variant="primary" onClick={() => retry.mutate()} loading={retry.isPending}>
                <RotateCcw size={14} aria-hidden /> Retry failed
              </Button>
            ) : null}
          </>
        }
      />

      {mutationError ? <ErrorNotice error={mutationError} className="mb-4" /> : null}
      {d.status === 'AWAITING_APPROVAL' ? (
        <div role="status" className="mb-4 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm">
          This deployment is waiting for approval{d.plan ? ` (plan risk: ${d.plan.risk})` : ''}. Review the plan below{canApprove ? ' and approve to continue' : ''}.
        </div>
      ) : null}
      {d.errorMessage ? (
        <div role="alert" className="mb-4 rounded-md border border-danger/30 bg-danger/8 px-3 py-2 text-sm">
          <p className="font-medium text-danger-ink">{d.errorClass ?? 'Deployment error'}</p>
          <p className="text-fg-muted">{d.errorMessage}</p>
        </div>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader
            title="Progress"
            description={`${done} of ${steps.length} steps complete${failed ? ` · ${failed} failed` : ''}`}
            actions={<span className="text-xs text-fg-subtle">Queued {formatDateTime(d.queuedAt)}</span>}
          />
          <div className="h-1 bg-surface-2" aria-hidden>
            <div className={cn('h-full', failed ? 'bg-danger' : 'bg-ok')} style={{ width: `${steps.length ? (done / steps.length) * 100 : 0}%` }} />
          </div>
          {steps.some((s) => s.startedAt) ? (
            <div className="border-b border-border">
              <p className="px-4 pt-2 text-[11px] font-medium uppercase tracking-wide text-fg-subtle">Timeline</p>
              <DeploymentGantt steps={steps} now={now} />
            </div>
          ) : null}
          <ol className="divide-y divide-border" aria-label="Deployment steps">
            {steps.map((s) => (
              <StepRow key={s.key} step={s} now={now} />
            ))}
            {steps.length === 0 ? <li className="px-4 py-6 text-sm text-fg-subtle">Steps appear once the worker picks up the deployment.</li> : null}
          </ol>
        </Card>

        <div className="space-y-4">
          <EventLog events={events} active={active} error={eventsError} />
          {d.status === 'SUCCEEDED' && d.outputs && Object.keys(d.outputs).length > 0 ? <Outputs outputs={d.outputs} /> : null}
          {d.plan ? (
            <Disclosure summary="Plan" className="bg-surface" defaultOpen={d.status === 'AWAITING_APPROVAL'}>
              <PlanSummary plan={d.plan} />
              <PlanGroups plan={d.plan} />
              <pre className="max-h-80 overflow-auto rounded bg-surface-2 p-2 font-mono text-xs">{d.plan.text}</pre>
            </Disclosure>
          ) : null}
          {d.cost ? (
            <Disclosure summary="Estimated cost (approximate)" className="bg-surface">
              <CostTable cost={d.cost} />
            </Disclosure>
          ) : null}
        </div>
      </div>

      <Dialog
        open={confirmCancel}
        onClose={() => setConfirmCancel(false)}
        title="Cancel deployment?"
        size="sm"
        footer={
          <>
            <Button onClick={() => setConfirmCancel(false)}>Keep running</Button>
            <Button variant="danger" onClick={() => cancel.mutate()} loading={cancel.isPending}>
              Cancel deployment
            </Button>
          </>
        }
      >
        <p className="text-sm text-fg-muted">
          Cancellation is cooperative: the step in progress finishes, then remaining steps are skipped. Resources already created are kept and can be removed by a destroy or reconciled by a later deploy.
        </p>
        {cancel.error ? <ErrorNotice error={cancel.error} className="mt-3" /> : null}
      </Dialog>
    </>
  );
}

function StepIcon({ status }: { status: DeploymentStepDto['status'] }) {
  switch (status) {
    case 'SUCCEEDED':
      return (
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-ok text-accent-fg">
          <Check size={12} strokeWidth={3} aria-hidden />
        </span>
      );
    case 'RUNNING':
      return <Spinner size={20} className="text-info-ink" />;
    case 'FAILED':
      return <XCircle size={20} className="text-danger-ink" aria-hidden />;
    case 'SKIPPED':
      return <Redo2 size={18} className="text-fg-subtle" aria-hidden />;
    case 'CANCELLED':
      return <X size={18} className="text-fg-subtle" aria-hidden />;
    default:
      return <Circle size={18} className="text-fg-subtle" aria-hidden />;
  }
}

function StepRow({ step: s, now }: { step: DeploymentStepDto; now: number }) {
  const duration = s.startedAt ? durationBetween(s.startedAt, s.finishedAt, now) : null;
  return (
    <li className={cn('flex gap-3 px-4 py-2.5', s.status === 'RUNNING' && 'bg-info/5', s.status === 'FAILED' && 'bg-danger/5')} aria-current={s.status === 'RUNNING' ? 'step' : undefined}>
      <span className="mt-0.5 flex w-5 shrink-0 justify-center">
        <StepIcon status={s.status} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className={cn('text-sm', s.status === 'PENDING' ? 'text-fg-subtle' : 'font-medium text-fg')}>{s.name}</span>
          <span className="sr-only">({s.status.toLowerCase()})</span>
          {s.kind === 'PHASE' ? <Badge>phase</Badge> : null}
          {s.provider ? (
            <span className="font-mono text-[11px] text-fg-subtle">
              {s.provider}
              {s.region ? ` / ${s.region}` : ''}
            </span>
          ) : null}
          {s.attempt > 1 ? <Badge tone="warn">attempt {s.attempt}</Badge> : null}
          {s.status === 'SKIPPED' ? <span className="text-xs text-fg-subtle">skipped</span> : null}
          <span className="ml-auto text-xs tabular-nums text-fg-subtle">{duration !== null ? formatDuration(duration) : ''}</span>
        </div>
        {s.errorMessage ? (
          <p className="mt-1 rounded bg-danger/8 px-2 py-1 text-xs text-danger-ink">
            {s.errorClass ? <span className="font-mono">{s.errorClass}: </span> : null}
            {s.errorMessage}
          </p>
        ) : null}
      </div>
    </li>
  );
}

const LEVEL_CLASS: Record<string, string> = { error: 'text-danger-ink', warn: 'text-warn-ink', debug: 'text-fg-subtle', info: 'text-info-ink' };

function EventLog({ events, active, error }: { events: DeploymentEventDto[]; active: boolean; error: unknown }) {
  const ref = useRef<HTMLDivElement>(null);
  const [stick, setStick] = useState(true);

  useEffect(() => {
    const el = ref.current;
    if (el && stick) el.scrollTop = el.scrollHeight;
  }, [events, stick]);

  return (
    <Card>
      <CardHeader
        title="Event log"
        description={active ? 'Streaming — refreshes every 1.5 s' : 'Complete'}
        actions={
          !stick ? (
            <Button size="sm" variant="ghost" onClick={() => setStick(true)}>
              Jump to latest
            </Button>
          ) : active ? (
            <Spinner size={13} className="text-fg-subtle" />
          ) : null
        }
      />
      {error ? <ErrorNotice error={error} className="m-3" /> : null}
      <div
        ref={ref}
        role="log"
        aria-label="Deployment events"
        onScroll={(e) => {
          const el = e.currentTarget;
          setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
        }}
        className="h-80 overflow-auto bg-surface-2/50 px-3 py-2 font-mono text-[11.5px] leading-relaxed"
      >
        {events.length === 0 ? (
          <p className="text-fg-subtle">Waiting for events…</p>
        ) : (
          events.map((e) => (
            <div key={e.id} className="flex gap-2.5 whitespace-pre-wrap break-words">
              <time dateTime={e.at} className="shrink-0 text-fg-subtle">
                {formatTime(e.at)}
              </time>
              <span className={cn('w-10 shrink-0 uppercase', LEVEL_CLASS[e.level] ?? 'text-fg-muted')}>{e.level}</span>
              {e.stepKey ? <span className="shrink-0 text-fg-subtle">[{e.stepKey}]</span> : null}
              <span className="min-w-0 text-fg">{e.message}</span>
            </div>
          ))
        )}
      </div>
    </Card>
  );
}

function Outputs({ outputs }: { outputs: Record<string, Record<string, unknown>> }) {
  return (
    <Card>
      <CardHeader title="Outputs" description="Secrets are shown only as references." />
      <CardBody className="space-y-3">
        {Object.entries(outputs).map(([resourceId, values]) => (
          <div key={resourceId}>
            <p className="mb-1 font-mono text-xs font-medium">{resourceId}</p>
            <dl className="space-y-0.5 text-xs">
              {Object.entries(values ?? {}).map(([k, v]) => {
                const out = displayOutput(k, v);
                return (
                  <div key={k} className="flex min-w-0 items-center gap-2">
                    <dt className="w-32 shrink-0 truncate text-fg-subtle">{k}</dt>
                    <dd className="flex min-w-0 items-center gap-1">
                      {out.hidden ? (
                        <span className="italic text-fg-subtle">hidden</span>
                      ) : (
                        <>
                          <code className={cn('truncate font-mono', out.reference ? 'text-info-ink' : 'text-fg-muted')} title={out.text}>
                            {out.text}
                          </code>
                          <CopyButton value={out.text} label={`Copy ${k}`} />
                        </>
                      )}
                    </dd>
                  </div>
                );
              })}
            </dl>
          </div>
        ))}
      </CardBody>
    </Card>
  );
}
