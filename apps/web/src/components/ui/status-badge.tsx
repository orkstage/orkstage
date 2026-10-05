import { statusLabel, toneOf, type Tone } from '@/lib/status';
import { cn } from '@/lib/utils';
import { Badge } from './badge';

const dotColor: Record<Tone, string> = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  danger: 'bg-danger',
  info: 'bg-info',
  neutral: 'bg-neutral',
  accent: 'bg-accent',
};

export function StatusDot({ status, tone, className }: { status?: string | null; tone?: Tone; className?: string }) {
  const t = tone ?? toneOf(status);
  return <span aria-hidden className={cn('inline-block h-2 w-2 shrink-0 rounded-full', dotColor[t], className)} />;
}

/** Badge with a colored dot; `prefix` renders e.g. "Health:" for screen readers and context. */
export function StatusBadge({
  status,
  label,
  prefix,
  className,
}: {
  status: string | null | undefined;
  label?: string;
  prefix?: string;
  className?: string;
}) {
  const tone = toneOf(status);
  return (
    <Badge tone={tone} className={className} title={prefix ? `${prefix}: ${statusLabel(status)}` : undefined}>
      <StatusDot tone={tone} className="h-1.5 w-1.5" />
      {prefix ? <span className="sr-only">{prefix}: </span> : null}
      {label ?? statusLabel(status)}
    </Badge>
  );
}
