'use client';

import { useSyncExternalStore } from 'react';

/**
 * UI theme preference. Dark is the default; light is opt-in. The choice is a cosmetic UI
 * preference stored in localStorage (never anything sensitive) and applied before first paint
 * by THEME_BOOTSTRAP in the root layout, so there is no flash.
 */
export type Theme = 'dark' | 'light';
export const THEME_STORAGE_KEY = 'orkstage-theme';

/** Inline, pre-paint script: sets <html data-theme>. Kept tiny and dependency-free. */
export const THEME_BOOTSTRAP = `(function(){try{var t=localStorage.getItem('${THEME_STORAGE_KEY}');document.documentElement.setAttribute('data-theme',t==='light'?'light':'dark')}catch(e){document.documentElement.setAttribute('data-theme','dark')}})();`;

function read(): Theme {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, read, () => 'dark');
}

export function setTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* storage unavailable (private mode): the choice lasts for this page only */
  }
}

/** Reads the current resolved token values (for canvas renderers such as charts). */
export function readTokens<K extends string>(names: readonly K[]): Record<K, string> {
  const style = getComputedStyle(document.documentElement);
  return Object.fromEntries(names.map((n) => [n, style.getPropertyValue(`--${n}`).trim()])) as Record<K, string>;
}
