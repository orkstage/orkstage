'use client';

import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import type { AppLocale } from '@/i18n/config';
import type { Messages } from '@/i18n/messages';
import { I18nProvider } from '@/i18n/provider';
import { isApiError } from '@/lib/api';

function redirectToLogin() {
  if (typeof window === 'undefined') return;
  const { pathname, search } = window.location;
  if (pathname.startsWith('/login')) return;
  window.location.assign(`/login?returnTo=${encodeURIComponent(pathname + search)}`);
}

function makeClient() {
  return new QueryClient({
    queryCache: new QueryCache({
      onError: (err) => {
        if (isApiError(err, 401)) redirectToLogin();
      },
    }),
    mutationCache: new MutationCache({
      onError: (err) => {
        if (isApiError(err, 401)) redirectToLogin();
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: 10_000,
        refetchOnWindowFocus: true,
        // Client errors (4xx) are answers, not glitches: do not retry them.
        retry: (count, err) => !(isApiError(err) && err.status >= 400 && err.status < 500) && count < 2,
      },
    },
  });
}

export function Providers({ locale, messages, children }: { locale: AppLocale; messages: Messages; children: ReactNode }) {
  const [client] = useState(makeClient);
  return (
    <I18nProvider locale={locale} messages={messages}>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </I18nProvider>
  );
}
