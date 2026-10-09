'use client';

import { useEffect, useState, type RefObject } from 'react';
import { useLocale } from 'use-intl';

/** Closes a popover on outside pointer-down or Escape. */
export function useDismiss(ref: RefObject<HTMLElement | null>, open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [ref, open, close]);
}

/**
 * Puts a record's name in front of the page's localized title ("acme-prod · Instance details ·
 * OrkStage") once it has loaded. Re-applied after a language switch re-renders the metadata.
 */
export function useDocumentTitle(name: string | null | undefined) {
  const locale = useLocale();
  useEffect(() => {
    if (!name) return;
    let applied = '';
    const apply = () => {
      if (document.title === applied) return;
      const base = document.title.startsWith(`${name} · `) ? document.title.slice(name.length + 3) : document.title;
      applied = `${name} · ${base}`;
      document.title = applied;
    };
    apply();
    // Next may rewrite <title> after navigation or refresh; put the name back when it does.
    const head = document.querySelector('head');
    const observer = head ? new MutationObserver(apply) : null;
    if (head && observer) observer.observe(head, { subtree: true, childList: true, characterData: true });
    return () => {
      observer?.disconnect();
      if (document.title === applied) document.title = applied.slice(name.length + 3);
    };
  }, [name, locale]);
}

/** Ticks every `ms` while `active`, returning the current time (for elapsed-time displays). */
export function useNow(active: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [active, ms]);
  return now;
}
