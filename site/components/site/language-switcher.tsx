import { type BilingualPage, getMessages, type Locale, localeConfig, localePath, locales } from '@/lib/i18n';

/**
 * EN / PT-BR links to the same page in the other locale. Plain anchors: each locale has its own
 * root layout (different `<html lang>`), so switching is a full page load anyway.
 */
export function LanguageSwitcher({ locale, path = '/', className = '' }: { locale: Locale; path?: BilingualPage; className?: string }) {
  const m = getMessages(locale);
  return (
    <nav aria-label={m.language.label} className={className}>
      <ul className="flex items-center rounded-md border border-hairline-strong p-0.5 font-mono text-[12px]">
        {locales.map((l) => {
          const current = l === locale;
          const cfg = localeConfig[l];
          return (
            <li key={l}>
              <a
                href={localePath(l, path)}
                hrefLang={cfg.htmlLang}
                lang={cfg.htmlLang}
                aria-current={current ? 'page' : undefined}
                className={`inline-flex h-7 min-w-9 items-center justify-center rounded px-2 tracking-wide ${
                  current ? 'bg-slate-2 text-ink' : 'text-ink-muted hover:text-ink'
                }`}
              >
                {cfg.short}
                <span className="sr-only"> ({cfg.name})</span>
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
