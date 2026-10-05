import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/utils';

export const controlClass =
  'block w-full rounded-md border border-control bg-surface px-2.5 text-sm text-fg placeholder:text-fg-subtle shadow-card focus:border-accent focus:outline-none focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-1 disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-danger';

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return <input className={cn(controlClass, 'h-8', className)} {...props} />;
}

/**
 * Label + control + hint + error. Pass the control's id as `htmlFor`; the hint/error ids are
 * `${htmlFor}-hint` / `${htmlFor}-error` so the control can reference them with aria-describedby.
 */
export function Field({
  label,
  htmlFor,
  hint,
  error,
  required,
  children,
  className,
}: {
  label: ReactNode;
  htmlFor: string;
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('space-y-1', className)}>
      <label htmlFor={htmlFor} className="block text-xs font-medium text-fg-muted">
        {label}
        {required ? <span className="ml-0.5 text-danger-ink" aria-hidden>*</span> : null}
      </label>
      {children}
      {hint && !error ? (
        <p id={`${htmlFor}-hint`} className="text-xs text-fg-subtle">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${htmlFor}-error`} role="alert" className="text-xs text-danger-ink">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** aria props for a control inside <Field>. */
export function describedBy(id: string, opts: { hint?: unknown; error?: unknown }) {
  return {
    'aria-invalid': opts.error ? true : undefined,
    'aria-describedby': opts.error ? `${id}-error` : opts.hint ? `${id}-hint` : undefined,
  } as const;
}
