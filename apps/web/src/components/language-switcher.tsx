'use client';

import { Check, Languages } from 'lucide-react';
import { useId } from 'react';
import { useLocale, useTranslations } from 'use-intl';
import { LOCALE_NAMES, LOCALES, type AppLocale } from '@/i18n/config';
import { useSwitchLocale } from '@/i18n/use-switch-locale';
import { cn } from '@/lib/utils';
import { Spinner } from './ui/spinner';

/** Language choice inside the user menu: one radio item per locale. */
export function LanguageMenuGroup() {
  const t = useTranslations('language');
  const locale = useLocale();
  const { switchLocale, pending } = useSwitchLocale();
  const labelId = useId();
  return (
    <div role="radiogroup" aria-labelledby={labelId} className="border-t border-border py-1">
      <p id={labelId} className="flex items-center gap-2 px-3 py-1 text-[11px] font-medium text-fg-subtle">
        <Languages size={12} aria-hidden /> {t('label')}
        {pending ? <Spinner size={11} label={t('changing')} /> : null}
      </p>
      {LOCALES.map((l) => (
        <button
          key={l}
          type="button"
          role="radio"
          aria-checked={l === locale}
          lang={l}
          disabled={pending}
          onClick={() => l !== locale && switchLocale(l)}
          className={cn(
            'flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm hover:bg-surface-2 hover:text-fg',
            l === locale ? 'text-fg' : 'text-fg-muted',
          )}
        >
          <span className="flex w-3.5 justify-center">{l === locale ? <Check size={13} aria-hidden /> : null}</span>
          {LOCALE_NAMES[l]}
        </button>
      ))}
    </div>
  );
}

/** Compact select for screens without the user menu (sign in). */
export function LanguageSelect({ className }: { className?: string }) {
  const t = useTranslations('language');
  const locale = useLocale();
  const { switchLocale, pending } = useSwitchLocale();
  const id = useId();
  return (
    <div className={cn('flex items-center gap-1.5 text-xs text-fg-subtle', className)}>
      <Languages size={13} aria-hidden />
      <label htmlFor={id} className="sr-only">
        {t('label')}
      </label>
      <select
        id={id}
        value={locale}
        disabled={pending}
        onChange={(e) => switchLocale(e.target.value as AppLocale)}
        className="rounded border border-border bg-surface px-1.5 py-0.5 text-xs text-fg-muted hover:text-fg focus:outline-none focus-visible:outline-2 focus-visible:outline-accent"
      >
        {LOCALES.map((l) => (
          <option key={l} value={l} lang={l}>
            {LOCALE_NAMES[l]}
          </option>
        ))}
      </select>
      {pending ? <Spinner size={11} label={t('changing')} /> : null}
    </div>
  );
}
