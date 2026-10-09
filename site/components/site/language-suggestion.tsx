'use client';
import { useEffect, useState } from 'react';

const STORAGE_KEY = 'orkstage.languageSuggestion';

/**
 * A small, dismissible hint that the page exists in the reader's browser language. Rendered only
 * in the browser (nothing in the static HTML, so crawlers never see it) and never redirects.
 * Positioned fixed, so it causes no layout shift.
 */
export function LanguageSuggestion({
  currentLocale,
  targetHref,
  targetLang,
  text,
  action,
  dismiss,
  region,
}: {
  currentLocale: 'en' | 'pt-BR';
  targetHref: string;
  targetLang: string;
  text: string;
  action: string;
  dismiss: string;
  region: string;
}) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    try {
      if (window.localStorage.getItem(STORAGE_KEY)) return;
    } catch {
      /* storage blocked: still fine to suggest */
    }
    const prefersPortuguese = (navigator.languages?.length ? navigator.languages : [navigator.language]).some((l) => l?.toLowerCase().startsWith('pt'));
    const wantsOther = currentLocale === 'en' ? prefersPortuguese : !prefersPortuguese;
    if (wantsOther) setShow(true);
  }, [currentLocale]);

  if (!show) return null;

  const remember = () => {
    try {
      window.localStorage.setItem(STORAGE_KEY, '1');
    } catch {
      /* ignore */
    }
  };

  return (
    <aside
      aria-label={region}
      lang={targetLang}
      className="fixed inset-x-4 bottom-4 z-50 mx-auto flex max-w-md flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-hairline-strong bg-slate-1 px-4 py-3 text-[14px] text-ink shadow-lg sm:inset-x-auto sm:right-6"
    >
      <p className="min-w-[13rem] flex-1">{text}</p>
      <div className="flex items-center gap-2">
        <a href={targetHref} hrefLang={targetLang} onClick={remember} className="rounded-md bg-mint px-3 py-1.5 font-semibold text-obsidian hover:bg-[#33f5af]">
          {action}
        </a>
        <button
          type="button"
          onClick={() => {
            remember();
            setShow(false);
          }}
          className="rounded-md px-2 py-1.5 text-ink-muted hover:text-ink"
        >
          {dismiss}
        </button>
      </div>
    </aside>
  );
}
