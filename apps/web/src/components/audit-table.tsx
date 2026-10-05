import type { AuditEventDto } from '@co/contracts';
import { MonoValue } from './ui/copy-button';
import { StatusBadge } from './ui/status-badge';
import { Table, TBody, TD, TH, THead, TR } from './ui/table';
import { formatDateTime, shortId } from '@/lib/utils';

export function AuditTable({ events, compact = false }: { events: AuditEventDto[]; compact?: boolean }) {
  return (
    <Table>
      <THead>
        <tr>
          <TH>Time</TH>
          <TH>Actor</TH>
          <TH>Action</TH>
          <TH>Resource</TH>
          <TH>Result</TH>
          {compact ? null : <TH>Correlation id</TH>}
          {compact ? null : <TH>Changes</TH>}
        </tr>
      </THead>
      <TBody>
        {events.map((e) => (
          <TR key={e.id}>
            <TD className="whitespace-nowrap text-xs text-fg-muted">
              <time dateTime={e.at}>{formatDateTime(e.at)}</time>
            </TD>
            <TD className="max-w-48 truncate" title={e.actorLabel ?? e.actorType}>
              {e.actorLabel ?? <span className="text-fg-subtle">{e.actorType}</span>}
            </TD>
            <TD>
              <code className="font-mono text-xs">{e.action}</code>
            </TD>
            <TD className="whitespace-nowrap text-xs">
              <span className="text-fg-muted">{e.resourceType}</span>
              {e.resourceId ? <span className="ml-1 font-mono text-fg-subtle" title={e.resourceId}>{shortId(e.resourceId)}</span> : null}
            </TD>
            <TD>
              <StatusBadge status={e.result} />
            </TD>
            {compact ? null : <TD>{e.correlationId ? <MonoValue value={e.correlationId} maxWidth="max-w-[9rem]" /> : <span className="text-fg-subtle">—</span>}</TD>}
            {compact ? null : (
              <TD>
                {e.changes && Object.keys(e.changes).length > 0 ? (
                  <details>
                    <summary className="text-xs text-accent-ink hover:underline">View</summary>
                    <pre className="mt-1 max-h-48 max-w-md overflow-auto rounded bg-surface-2 p-2 text-[11px]">{JSON.stringify(e.changes, null, 2)}</pre>
                  </details>
                ) : (
                  <span className="text-fg-subtle">—</span>
                )}
              </TD>
            )}
          </TR>
        ))}
      </TBody>
    </Table>
  );
}
