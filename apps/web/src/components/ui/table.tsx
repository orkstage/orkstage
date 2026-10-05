import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export function Table({ className, wrapperClassName, ...props }: ComponentProps<'table'> & { wrapperClassName?: string }) {
  return (
    <div className={cn('w-full overflow-x-auto', wrapperClassName)}>
      <table className={cn('w-full border-collapse text-left text-sm', className)} {...props} />
    </div>
  );
}

export function THead({ className, ...props }: ComponentProps<'thead'>) {
  return <thead className={cn('border-b border-border bg-surface-2/60 text-xs text-fg-subtle', className)} {...props} />;
}

export function TBody({ className, ...props }: ComponentProps<'tbody'>) {
  return <tbody className={cn('divide-y divide-border', className)} {...props} />;
}

export function TR({ className, ...props }: ComponentProps<'tr'>) {
  return <tr className={cn('align-middle hover:bg-surface-2/50', className)} {...props} />;
}

export function TH({ className, scope = 'col', ...props }: ComponentProps<'th'>) {
  return <th scope={scope} className={cn('whitespace-nowrap px-3 py-2 font-medium', className)} {...props} />;
}

export function TD({ className, ...props }: ComponentProps<'td'>) {
  return <td className={cn('px-3 py-2', className)} {...props} />;
}
