import './global.css';
import type { Metadata } from 'next';
import { Logo } from '@/components/logo';
import { fontVariables } from '@/lib/fonts';
import { getMessages, type Locale, localeConfig, localePath } from '@/lib/i18n';
import { links } from '@/lib/shared';

/**
 * The single 404.html of the static export (CloudFront serves it for every missing path). It
 * carries both languages; a tiny inline script picks Portuguese before first paint when the
 * missing path is under /pt-br/, and sets `<html lang>` and the title to match.
 */
const en = getMessages('en');
const pt = getMessages('pt-BR');

export const metadata: Metadata = {
  title: `${en.meta.notFoundTitle} | OrkStage`,
  description: en.meta.notFoundDescription,
};

const prefix = localeConfig['pt-BR'].prefix;
// The <title> comes after this script and React sets it again on hydration, so a small observer keeps it in Portuguese.
const script = `(function(){var p=location.pathname.toLowerCase();if(p==='${prefix}'||p.indexOf('${prefix}/')===0){var d=document.documentElement,t=${JSON.stringify(`${pt.meta.notFoundTitle} | OrkStage`)};d.lang='pt-BR';d.setAttribute('data-locale','pt-BR');var fix=function(){if(document.title!==t)document.title=t;if(d.lang!=='pt-BR')d.lang='pt-BR';};new MutationObserver(fix).observe(d,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['lang']});document.addEventListener('DOMContentLoaded',fix);}})();`;
const css = `.l-pt{display:none}[data-locale="pt-BR"] .l-pt{display:flex}[data-locale="pt-BR"] .l-en{display:none}`;

function Block({ locale }: { locale: Locale }) {
  const m = getMessages(locale);
  const docsLang = locale === 'en' ? undefined : 'en';
  return (
    <div className={`${locale === 'en' ? 'l-en flex' : 'l-pt'} flex-col items-center gap-6`} lang={localeConfig[locale].htmlLang}>
      <h1 className="font-display text-3xl font-semibold tracking-tight">{m.notFound.title}</h1>
      <p className="max-w-md text-ink-muted">{m.notFound.text}</p>
      <div className="flex flex-wrap justify-center gap-3">
        <a href={links.docs} hrefLang={docsLang} className="rounded-md bg-mint px-4 py-2 font-medium text-obsidian">
          {m.notFound.docs}
        </a>
        <a href={localePath(locale, '/')} className="rounded-md border border-hairline-strong px-4 py-2 font-medium text-ink">
          {m.notFound.home}
        </a>
      </div>
    </div>
  );
}

export default function GlobalNotFound() {
  return (
    <html lang="en" className={fontVariables} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: script }} />
        <style dangerouslySetInnerHTML={{ __html: css }} />
      </head>
      <body className="bg-obsidian text-ink">
        <main className="bg-grid flex min-h-screen flex-1 flex-col items-center justify-center gap-8 px-4 text-center">
          <Logo height={44} forceDark />
          <Block locale="en" />
          <Block locale="pt-BR" />
        </main>
      </body>
    </html>
  );
}
