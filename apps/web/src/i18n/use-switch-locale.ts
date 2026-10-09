'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE, type AppLocale } from './config';

/**
 * Stores the chosen language in the NEXT_LOCALE cookie and re-renders the server tree, so the
 * root layout picks the new dictionary and `<html lang>`. Client state (queries, forms) is kept.
 */
export function useSwitchLocale(): { switchLocale: (locale: AppLocale) => void; pending: boolean } {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const switchLocale = (locale: AppLocale) => {
    const secure = window.location.protocol === 'https:' ? '; secure' : '';
    document.cookie = `${LOCALE_COOKIE}=${encodeURIComponent(locale)}; path=/; max-age=${LOCALE_COOKIE_MAX_AGE}; samesite=lax${secure}`;
    startTransition(() => router.refresh());
  };
  return { switchLocale, pending };
}
