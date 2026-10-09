import { Logo } from '@/components/logo';
import { Rich } from '@/components/rich';
import { type BilingualPage, getMessages, type Locale, localePath } from '@/lib/i18n';
import { links } from '@/lib/shared';
import { LanguageSuggestion } from './language-suggestion';
import { LanguageSwitcher } from './language-switcher';

/** Docs are English only: links to them from another locale say so with hreflang. */
function docsLang(locale: Locale) {
  return locale === 'en' ? undefined : 'en';
}

export function SkipLink({ locale }: { locale: Locale }) {
  return (
    <a href="#main" className="sr-only z-50 rounded bg-mint px-3 py-2 font-medium text-obsidian focus:not-sr-only focus:fixed focus:left-4 focus:top-4">
      {getMessages(locale).common.skipToContent}
    </a>
  );
}

export function SiteHeader({ locale, path = '/' }: { locale: Locale; path?: BilingualPage }) {
  const m = getMessages(locale);
  const hl = docsLang(locale);
  return (
    <header className="sticky top-0 z-40 border-b border-hairline bg-obsidian/90 backdrop-blur supports-[backdrop-filter]:bg-obsidian/75">
      <div className="mx-auto flex h-16 max-w-[1200px] items-center justify-between gap-3 px-4 sm:px-6">
        <a href={localePath(locale, '/')} aria-label={m.common.homeLabel} className="shrink-0 rounded focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-mint">
          <Logo height={30} forceDark alt="" />
        </a>
        <div className="flex items-center gap-2 sm:gap-3">
          <nav aria-label={m.common.mainNav}>
            <ul className="flex items-center gap-1 text-[14px]">
              <li className="hidden md:block">
                <a href={links.docs} hrefLang={hl} className="rounded px-3 py-2 text-ink-muted hover:text-ink">
                  {m.common.docs}
                </a>
              </li>
              <li className="hidden md:block">
                <a href={links.apiReference} hrefLang={hl} className="rounded px-3 py-2 text-ink-muted hover:text-ink">
                  {m.common.api}
                </a>
              </li>
              <li className="hidden sm:block">
                <a href={links.github} className="rounded px-3 py-2 text-ink-muted hover:text-ink">
                  {m.common.github}
                </a>
              </li>
            </ul>
          </nav>
          <LanguageSwitcher locale={locale} path={path} />
          <a href={links.quickstart} hrefLang={hl} className="inline-flex h-9 items-center whitespace-nowrap rounded-md bg-mint px-3.5 text-[14px] font-semibold text-obsidian hover:bg-[#33f5af]">
            {m.common.getStarted}
          </a>
        </div>
      </div>
    </header>
  );
}

export function SiteFooter({ locale, path = '/' }: { locale: Locale; path?: BilingualPage }) {
  const m = getMessages(locale);
  const f = m.footer;
  const hl = docsLang(locale);
  const cols: { title: string; items: [string, string][] }[] = [
    { title: f.product, items: [[f.documentation, links.docs], [f.quickstart, links.quickstart], [f.apiReference, links.apiReference]] },
    { title: f.project, items: [[m.common.github, links.github], [f.license, links.license], [f.security, links.security]] },
    { title: f.company, items: [[f.enterprise, links.enterprise], [f.contact, links.contact]] },
  ];
  return (
    <footer className="border-t border-hairline">
      <div className="mx-auto grid max-w-[1200px] gap-10 px-4 py-14 sm:px-6 md:grid-cols-12">
        <div className="md:col-span-5">
          <Logo height={30} forceDark />
          <p className="mt-4 max-w-sm text-[14px] text-ink-muted">{f.tagline}</p>
          <LanguageSwitcher locale={locale} path={path} className="mt-6 inline-block" />
        </div>
        <nav aria-label={m.common.footerNav} className="grid grid-cols-2 gap-8 text-[14px] sm:grid-cols-3 md:col-span-7">
          {cols.map((col) => (
            <div key={col.title}>
              <h2 className="font-mono text-[11.5px] font-normal uppercase tracking-[0.14em] text-ink-subtle">{col.title}</h2>
              <ul className="mt-3 space-y-2">
                {col.items.map(([label, href]) => (
                  <li key={label}>
                    {href.startsWith('/') ? (
                      <a href={href} hrefLang={hl} className="text-ink-muted hover:text-ink">
                        {label}
                      </a>
                    ) : (
                      <a href={href} className="text-ink-muted hover:text-ink">
                        {label}
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        <div className="space-y-2 text-[12.5px] text-ink-subtle md:col-span-12">
          {locale !== 'en' ? <p>{m.common.docsLanguageNote}</p> : null}
          <p>
            <Rich text={f.legal} codeClassName="font-mono" />
          </p>
        </div>
      </div>
    </footer>
  );
}

/** Suggests the other locale when the browser language points there (client only). */
export function LocaleHint({ locale, path = '/' }: { locale: Locale; path?: BilingualPage }) {
  const target: Locale = locale === 'en' ? 'pt-BR' : 'en';
  const t = getMessages(target).language;
  return (
    <LanguageSuggestion
      currentLocale={locale}
      targetHref={localePath(target, path)}
      targetLang={target}
      text={t.suggestion}
      action={t.suggestionAction}
      dismiss={t.dismiss}
      region={t.suggestionRegion}
    />
  );
}
