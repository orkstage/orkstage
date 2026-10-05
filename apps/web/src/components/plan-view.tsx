import type { PreviewDto, ValidationIssueDto } from '@co/contracts';
import { ArrowRight, Globe2 } from 'lucide-react';
import { cn, formatMoney } from '@/lib/utils';
import { Badge } from './ui/badge';
import { Card, CardBody, CardHeader } from './ui/card';
import { StatusBadge } from './ui/status-badge';
import { Table, TBody, TD, TH, THead, TR } from './ui/table';

const ACTION_TONE = { CREATE: 'ok', UPDATE: 'warn', DELETE: 'danger', NOOP: 'neutral' } as const;
const RISK_TONE = { low: 'ok', medium: 'warn', high: 'danger' } as const;

export function IssuesList({ issues }: { issues: ValidationIssueDto[] }) {
  if (issues.length === 0) return <p className="text-sm text-ok-ink">No validation issues.</p>;
  return (
    <ul className="space-y-2">
      {issues.map((issue, i) => (
        <li key={`${issue.code}-${i}`} className={cn('rounded-md border-l-2 bg-surface-2/60 px-3 py-2', issue.severity === 'error' ? 'border-danger' : 'border-warn')}>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={issue.severity === 'error' ? 'danger' : 'warn'}>{issue.severity}</Badge>
            <code className="font-mono text-[11px] text-fg-subtle">{issue.code}</code>
            <Badge>{issue.stage}</Badge>
            {issue.path ? <code className="font-mono text-[11px] text-fg-muted">{issue.path}</code> : null}
          </div>
          <p className="mt-1 text-sm">{issue.message}</p>
          {issue.suggestions && issue.suggestions.length > 0 ? (
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-fg-muted">
              {issue.suggestions.map((s, j) => (
                <li key={j}>{s}</li>
              ))}
            </ul>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export function PlanSummary({ plan }: { plan: PreviewDto['plan'] }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {(['CREATE', 'UPDATE', 'DELETE', 'NOOP'] as const).map((a) => (
        <Badge key={a} tone={plan.counts[a] > 0 ? ACTION_TONE[a] : 'neutral'}>
          {plan.counts[a] ?? 0} {a.toLowerCase()}
        </Badge>
      ))}
      <Badge tone={RISK_TONE[plan.risk]}>Risk: {plan.risk}</Badge>
      {plan.crossCloud.length > 0 ? (
        <Badge tone="info" title={plan.crossCloud.join(', ')}>
          <Globe2 size={11} aria-hidden /> {plan.crossCloud.length} cross-cloud link{plan.crossCloud.length === 1 ? '' : 's'}
        </Badge>
      ) : null}
    </div>
  );
}

export function PlanGroups({ plan }: { plan: PreviewDto['plan'] }) {
  if (plan.groups.length === 0) return <p className="text-sm text-fg-subtle">No changes.</p>;
  return (
    <div className="space-y-3">
      {plan.groups.map((g, i) => (
        <div key={`${g.provider}-${g.targetName}-${g.region}-${i}`} className="rounded-md border border-border">
          <p className="flex flex-wrap items-center gap-2 border-b border-border bg-surface-2/60 px-3 py-1.5 text-xs">
            <span className="font-mono font-medium">{g.provider}</span>
            <span className="text-fg-muted">{g.targetName}</span>
            <span className="font-mono text-fg-subtle">{g.region}</span>
          </p>
          <ul className="divide-y divide-border">
            {g.changes.map((c) => (
              <li key={c.resourceId} className="flex flex-wrap items-center gap-2 px-3 py-1.5 text-sm">
                <Badge tone={ACTION_TONE[c.action as keyof typeof ACTION_TONE] ?? 'neutral'} className="w-16 justify-center">
                  {c.action}
                </Badge>
                <code className="font-mono text-xs">{c.resourceId}</code>
                <span className="text-fg-muted">{c.capabilityName}</span>
                {c.replacement ? <Badge tone="danger">Replacement</Badge> : null}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

export function CostTable({ cost }: { cost: PreviewDto['cost'] }) {
  return (
    <div>
      <Table>
        <THead>
          <tr>
            <TH>Resource</TH>
            <TH>Category</TH>
            <TH>Provider</TH>
            <TH>Source</TH>
            <TH className="text-right">Monthly</TH>
          </tr>
        </THead>
        <TBody>
          {cost.lines.map((l, i) => (
            <TR key={`${l.resourceId}-${l.category}-${i}`}>
              <TD>
                <code className="font-mono text-xs">{l.resourceId}</code>
              </TD>
              <TD className="text-fg-muted">{l.category}</TD>
              <TD className="font-mono text-xs">{l.provider}</TD>
              <TD className="text-xs text-fg-subtle">{l.source}</TD>
              <TD className="text-right tabular-nums">{l.monthly === null ? <span className="text-fg-subtle">n/a</span> : formatMoney(l.monthly, cost.currency)}</TD>
            </TR>
          ))}
        </TBody>
        <tfoot>
          <tr className="border-t-2 border-border font-semibold">
            <TD colSpan={4}>
              Total <span className="ml-1 text-xs font-normal text-fg-subtle">confidence: {cost.confidence}</span>
            </TD>
            <TD className="text-right tabular-nums">{formatMoney(cost.total, cost.currency)}</TD>
          </tr>
        </tfoot>
      </Table>
      <p className="px-3 py-2 text-xs text-fg-subtle">Estimated monthly — approximate, not an invoice. Taxes, data transfer and usage-based charges may differ.</p>
    </div>
  );
}

export function PreviewReport({ preview }: { preview: PreviewDto }) {
  const errors = preview.issues.filter((i) => i.severity === 'error').length;
  const failedPolicies = preview.policyResults.filter((p) => p.status === 'fail').length;
  return (
    <div className="space-y-4">
      <Card>
        <CardBody className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={preview.valid ? 'PASS' : 'FAIL'} label={preview.valid ? 'Valid — ready to deploy' : 'Invalid — cannot deploy'} />
            {errors ? <Badge tone="danger">{errors} error{errors === 1 ? '' : 's'}</Badge> : null}
            {failedPolicies ? <Badge tone="danger">{failedPolicies} policy failure{failedPolicies === 1 ? '' : 's'}</Badge> : null}
            {preview.simulated ? <Badge tone="accent">SIMULATED</Badge> : null}
          </div>
          <PlanSummary plan={preview.plan} />
        </CardBody>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Validation" description="Schema, semantic and capability checks with suggested fixes." as="h3" />
          <CardBody>
            <IssuesList issues={preview.issues} />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Policies" as="h3" />
          {preview.policyResults.length === 0 ? (
            <CardBody>
              <p className="text-sm text-fg-subtle">No policies evaluated.</p>
            </CardBody>
          ) : (
            <ul className="divide-y divide-border">
              {preview.policyResults.map((p, i) => (
                <li key={`${p.policy}-${i}`} className="flex items-start gap-2 px-4 py-2">
                  <StatusBadge status={p.status} label={p.status} className="mt-0.5 w-14 justify-center" />
                  <div className="min-w-0 text-sm">
                    <p className="font-medium">
                      {p.policy}
                      {p.resourceId ? <code className="ml-1.5 font-mono text-xs font-normal text-fg-subtle">{p.resourceId}</code> : null}
                    </p>
                    <p className="text-fg-muted">{p.message}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card>
        <CardHeader title="Connectivity" description="How resources reach each other. Cross-cloud links are highlighted." as="h3" />
        {preview.connectivity.length === 0 ? (
          <CardBody>
            <p className="text-sm text-fg-subtle">No connectivity requirements.</p>
          </CardBody>
        ) : (
          <ul className="divide-y divide-border">
            {preview.connectivity.map((c, i) => (
              <li key={`${c.from}-${c.to}-${i}`} className={cn('px-4 py-2', c.crossCloud && 'border-l-2 border-info bg-info/5')}>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <code className="font-mono text-xs">{c.from}</code>
                  <ArrowRight size={13} className="text-fg-subtle" aria-label="to" />
                  <code className="font-mono text-xs">{c.to}</code>
                  <Badge>{c.protocol}</Badge>
                  <Badge>{c.mode}</Badge>
                  <Badge tone={c.crossCloud ? 'info' : 'neutral'}>strategy: {c.strategy}</Badge>
                  {c.crossCloud ? (
                    <Badge tone="info">
                      <Globe2 size={11} aria-hidden /> Cross-cloud
                    </Badge>
                  ) : null}
                </div>
                {c.notes.length > 0 ? (
                  <ul className="mt-1 list-disc pl-5 text-xs text-fg-muted">
                    {c.notes.map((n, j) => (
                      <li key={j}>{n}</li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Estimated cost" description="Estimated monthly — approximate, not an invoice." as="h3" />
          <CostTable cost={preview.cost} />
        </Card>
        <Card>
          <CardHeader title="Plan" as="h3" actions={<PlanSummary plan={preview.plan} />} />
          <CardBody>
            <PlanGroups plan={preview.plan} />
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader title="Plan output" as="h3" />
        <pre className="max-h-[28rem] overflow-auto px-4 py-3 font-mono text-xs leading-relaxed">{preview.plan.text}</pre>
      </Card>
    </div>
  );
}
