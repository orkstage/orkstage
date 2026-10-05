'use client';

import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
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

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(makeClient);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
