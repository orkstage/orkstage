import { AlertTriangle } from 'lucide-react';
import type { ReactNode } from 'react';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';

/** Shows an API error message, plus the correlation id in small print for support. */
export function ErrorNotice({ error, title, action, className }: { error: unknown; title?: string; action?: ReactNode; className?: string }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : 'Something went wrong.';
  const api = error instanceof ApiError ? error : null;
  return (
    <div role="alert" className={cn('flex items-start gap-2.5 rounded-md border border-danger/30 bg-danger/8 px-3 py-2.5 text-sm', className)}>
      <AlertTriangle size={16} className="mt-0.5 shrink-0 text-danger-ink" aria-hidden />
      <div className="min-w-0 flex-1">
        {title ? <p className="font-medium text-fg">{title}</p> : null}
        <p className="text-fg-muted">{message}</p>
        {api?.correlationId ? (
          <p className="mt-1 font-mono text-[11px] text-fg-subtle">
            {api.code} · correlation id <span className="select-all">{api.correlationId}</span>
          </p>
        ) : api ? (
          <p className="mt-1 font-mono text-[11px] text-fg-subtle">{api.code}</p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

/** Inline success/info note. */
export function Notice({ tone = 'info', children, className }: { tone?: 'info' | 'warn' | 'ok'; children: ReactNode; className?: string }) {
  return (
    <div
      role="status"
      className={cn(
        'rounded-md border px-3 py-2 text-sm',
        tone === 'info' && 'border-info/30 bg-info/8 text-fg',
        tone === 'warn' && 'border-warn/35 bg-warn/10 text-fg',
        tone === 'ok' && 'border-ok/30 bg-ok/8 text-fg',
        className,
      )}
    >
      {children}
    </div>
  );
}
