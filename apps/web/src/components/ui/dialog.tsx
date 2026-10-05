'use client';

import { X } from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Controlled wrapper around the native <dialog> element: it provides the modal focus trap,
 * Esc handling and inert background for free. Content is only mounted while open so forms
 * reset between openings.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
  variant = 'modal',
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  variant?: 'modal' | 'drawer';
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const downOnBackdrop = useRef(false);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  const width = { sm: 'w-[min(26rem,calc(100vw-2rem))]', md: 'w-[min(34rem,calc(100vw-2rem))]', lg: 'w-[min(46rem,calc(100vw-2rem))]', xl: 'w-[min(64rem,calc(100vw-2rem))]' }[size];

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      onClose={() => {
        if (open) onClose();
      }}
      onMouseDown={(e) => {
        downOnBackdrop.current = e.target === ref.current;
      }}
      onClick={(e) => {
        if (downOnBackdrop.current && e.target === ref.current) onClose();
        downOnBackdrop.current = false;
      }}
      className={cn(
        'border border-border bg-surface p-0 text-fg shadow-2xl',
        variant === 'modal' && cn('m-auto max-h-[calc(100dvh-2rem)] rounded-lg', width),
        variant === 'drawer' && 'my-0 mr-0 ml-auto h-dvh max-h-dvh w-[min(40rem,100vw)] rounded-none border-y-0 border-r-0',
        className,
      )}
    >
      {open ? (
        <div className={cn('flex flex-col', variant === 'drawer' ? 'h-full' : 'max-h-[calc(100dvh-2rem)]')}>
          <header className="flex items-start justify-between gap-3 border-b border-border px-5 py-3.5">
            <div className="min-w-0">
              <h2 id={titleId} className="text-base font-semibold">
                {title}
              </h2>
              {description ? (
                <p id={descId} className="mt-0.5 text-xs text-fg-subtle">
                  {description}
                </p>
              ) : null}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="-mr-1.5 rounded p-1 text-fg-subtle hover:bg-surface-2 hover:text-fg"
              aria-label="Close dialog"
            >
              <X size={16} />
            </button>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer ? <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-3">{footer}</footer> : null}
        </div>
      ) : null}
    </dialog>
  );
}
