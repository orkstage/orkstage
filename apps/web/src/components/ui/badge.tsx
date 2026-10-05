import type { ReactNode } from 'react';
import type { Tone } from '@/lib/status';
import { cn } from '@/lib/utils';

const tones: Record<Tone, string> = {
  ok: 'bg-ok/12 text-ok-ink ring-ok/25',
  warn: 'bg-warn/12 text-warn-ink ring-warn/30',
  danger: 'bg-danger/12 text-danger-ink ring-danger/30',
  info: 'bg-info/12 text-info-ink ring-info/30',
  neutral: 'bg-neutral/12 text-fg-muted ring-neutral/25',
  accent: 'bg-accent/12 text-accent-ink ring-accent/30',
};

export function Badge({ tone = 'neutral', children, className, title }: { tone?: Tone; children: ReactNode; className?: string; title?: string }) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded px-1.5 text-[11px] font-medium leading-none ring-1 ring-inset',
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Explicit marker for anything produced by the mock provider: never confuse it with real cloud. */
export function SimulatedBadge({ simulates, className }: { simulates?: string | null; className?: string }) {
  return (
    <Badge tone="accent" className={cn('uppercase tracking-wide', className)} title="Runs on the mock provider; no real cloud resources">
      Simulated{simulates ? ` · ${simulates}` : ''}
    </Badge>
  );
}
