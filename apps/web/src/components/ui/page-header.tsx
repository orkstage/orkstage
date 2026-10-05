import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function PageHeader({
  title,
  description,
  actions,
  meta,
  breadcrumb,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  meta?: ReactNode;
  breadcrumb?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('mb-5 space-y-1', className)}>
      {breadcrumb ? <nav aria-label="Breadcrumb" className="text-xs text-fg-subtle">{breadcrumb}</nav> : null}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="font-display text-[22px] font-semibold tracking-[-0.015em] text-fg">{title}</h1>
          {description ? <p className="mt-0.5 text-sm text-fg-subtle">{description}</p> : null}
          {meta ? <div className="mt-2 flex flex-wrap items-center gap-2">{meta}</div> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}

/** Progressive disclosure for advanced settings: collapsed by default. */
export function Disclosure({ summary, children, defaultOpen = false, className }: { summary: ReactNode; children: ReactNode; defaultOpen?: boolean; className?: string }) {
  return (
    <details open={defaultOpen} className={cn('group rounded-md border border-border', className)}>
      <summary className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-fg-muted hover:text-fg">
        <span aria-hidden className="inline-block transition-transform group-open:rotate-90">›</span>
        {summary}
      </summary>
      <div className="space-y-3 border-t border-border px-3 py-3">{children}</div>
    </details>
  );
}

/** Definition list for key/value metadata. */
export function KeyValues({ items, className }: { items: { label: ReactNode; value: ReactNode }[]; className?: string }) {
  return (
    <dl className={cn('grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-4 gap-y-1.5 text-sm', className)}>
      {items.map((item, i) => (
        <div key={i} className="contents">
          <dt className="text-fg-subtle">{item.label}</dt>
          <dd className="min-w-0 break-words text-fg">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
