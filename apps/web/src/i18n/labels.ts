'use client';

import { useCallback } from 'react';
import { useTranslations } from 'use-intl';
import { ApiError } from '@/lib/api';
import { humanize } from '@/lib/utils';
import type { Messages } from './messages';

type StatusKey = keyof Messages['status'];
type ErrorCodeKey = keyof Messages['errors']['codes'];

/**
 * Translated label for a status enum (READY, DEGRADED, pass, high...). Unknown values fall back
 * to a humanized form of the raw value, so a new API status still reads sensibly.
 */
export function useStatusLabel() {
  const t = useTranslations('status');
  return useCallback(
    (status: string | null | undefined): string => {
      if (!status) return t('UNKNOWN');
      const key = status.toUpperCase() as StatusKey;
      return t.has(key) ? t(key) : humanize(status);
    },
    [t],
  );
}

type EnvironmentKey = keyof Messages['environments'];

/** Translated environment name (production, staging...); custom names are shown as they are. */
export function useEnvironmentLabel() {
  const t = useTranslations('environments');
  return useCallback((env: string | null | undefined): string => (env && t.has(env as EnvironmentKey) ? t(env as EnvironmentKey) : (env ?? '')), [t]);
}

/** The API's default 403 text; a custom 403 message carries more detail and is kept as is. */
const DEFAULT_FORBIDDEN = 'You do not have permission to perform this action.';

/**
 * User-facing text for an error. API messages stay as the API sends them (English), except for
 * stable error codes the console knows: those are translated, with the API message as fallback.
 */
export function useErrorMessage() {
  const t = useTranslations('errors');
  return useCallback(
    (error: unknown): string => {
      if (error instanceof ApiError) {
        const code = error.code as ErrorCodeKey;
        if (code === 'FORBIDDEN' && error.message !== DEFAULT_FORBIDDEN) return error.message;
        if (t.has(`codes.${code}`)) {
          const feature = typeof error.details.feature === 'string' ? error.details.feature : '';
          return t(`codes.${code}`, { feature });
        }
        if (error.code === `HTTP_${error.status}`) {
          if (error.status === 401) return t('codes.UNAUTHENTICATED');
          if (error.status === 403) return t('codes.FORBIDDEN');
          if (error.status === 404) return t('http.notFound');
          if (error.status >= 500) return t('http.server');
          return t('http.other', { status: error.status });
        }
        return error.message;
      }
      if (error instanceof Error && error.message) return error.message;
      return t('generic');
    },
    [t],
  );
}
