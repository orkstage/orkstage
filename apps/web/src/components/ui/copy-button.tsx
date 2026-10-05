'use client';

import { Check, Copy } from 'lucide-react';
import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

export function CopyButton({ value, label = 'Copy', className }: { value: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
        } catch {
          /* clipboard unavailable (insecure context); nothing else to do */
        }
      }}
      className={cn('inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-subtle hover:bg-surface-2 hover:text-fg', className)}
      aria-label={copied ? 'Copied' : label}
      title={copied ? 'Copied' : label}
    >
      {copied ? <Check size={12} className="text-ok-ink" /> : <Copy size={12} />}
    </button>
  );
}

/** Monospace value truncated in the middle-ish (CSS ellipsis) with a copy button. */
export function MonoValue({ value, className, maxWidth = 'max-w-[18rem]' }: { value: string; className?: string; maxWidth?: string }) {
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1', className)}>
      <code className={cn('truncate font-mono text-xs text-fg-muted', maxWidth)} title={value}>
        {value}
      </code>
      <CopyButton value={value} label={`Copy ${value}`} />
    </span>
  );
}
