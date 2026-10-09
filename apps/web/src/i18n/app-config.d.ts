import type { AppLocale } from './config';
import type { Messages } from './messages';

/**
 * Types every `t('...')` key against messages/en.json: a missing or misspelled key fails
 * `pnpm --filter @co/web typecheck`. pt-BR.json is checked against the same shape in messages.ts.
 */
declare module 'use-intl' {
  interface AppConfig {
    Locale: AppLocale;
    Messages: Messages;
  }
}
