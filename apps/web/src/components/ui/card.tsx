import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function Card({ className, ...props }: ComponentProps<'section'>) {
  return <section className={cn('rounded-lg border border-border bg-surface shadow-card', className)} {...props} />;
}

export function CardHeader({
  title,
  description,
  actions,
  className,
  as: Heading = 'h2',
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
  as?: 'h2' | 'h3';
}) {
  return (
    <header className={cn('flex flex-wrap items-start justify-between gap-2 border-b border-border px-4 py-3', className)}>
      <div className="min-w-0">
        <Heading className="text-sm font-semibold text-fg">{title}</Heading>
        {description ? <p className="mt-0.5 text-xs text-fg-subtle">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function CardBody({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('px-4 py-3', className)} {...props} />;
}

/** Compact KPI tile for overview pages. */
export function StatCard({
  label,
  value,
  hint,
  tone,
  children,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'danger' | 'warn' | 'ok';
  children?: ReactNode;
}) {
  return (
    <Card className="px-4 py-3">
      <p className="text-xs font-medium text-fg-subtle">{label}</p>
      <p className={cn('mt-1 font-display text-2xl font-semibold', tone === 'danger' && 'text-danger-ink', tone === 'warn' && 'text-warn-ink', tone === 'ok' && 'text-ok-ink')}>
        {value}
      </p>
      {hint ? <p className="mt-0.5 text-xs text-fg-subtle">{hint}</p> : null}
      {children}
    </Card>
  );
}
