'use client';

import { useTranslations } from 'use-intl';
import { cn } from '@/lib/utils';
import { CopyButton } from './ui/copy-button';

/** Read only source viewer with line numbers (no syntax highlighting library). */
export function YamlViewer({ source, className, label }: { source: string; className?: string; label?: string }) {
  const t = useTranslations('yaml');
  const lines = source.replace(/\n$/, '').split('\n');
  return (
    <div className={cn('relative rounded-md border border-border bg-surface-2/50', className)}>
      <div className="absolute right-2 top-2">
        <CopyButton value={source} label={t('copySource')} />
      </div>
      <pre aria-label={label ?? t('source')} className="max-h-[36rem] overflow-auto py-2 font-mono text-xs leading-relaxed" tabIndex={0}>
        <code>
          {lines.map((line, i) => (
            <span key={i} className="flex">
              <span aria-hidden className="w-10 shrink-0 select-none pr-3 text-right text-fg-subtle">
                {i + 1}
              </span>
              <span className="whitespace-pre pr-8">{line || ' '}</span>
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}
