'use client';

import type { ReactNode } from 'react';
import { IntlProvider, IntlErrorCode, type IntlError } from 'use-intl';
import type { AppLocale } from './config';
import type { Messages } from './messages';

function onError(error: IntlError) {
  // A missing key is a bug (typecheck should have caught it): log it loudly in development only.
  if (process.env.NODE_ENV !== 'production' || error.code !== IntlErrorCode.MISSING_MESSAGE) console.error(error);
}

/**
 * Gives client components the dictionary of the active locale. The server picks the locale (see
 * i18n/server.ts) and passes only that dictionary, so the other language is never shipped.
 */
export function I18nProvider({ locale, messages, children }: { locale: AppLocale; messages: Messages; children: ReactNode }) {
  return (
    <IntlProvider locale={locale} messages={messages} onError={onError} getMessageFallback={({ key }) => key}>
      {children}
    </IntlProvider>
  );
}
