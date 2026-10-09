import en from '../../messages/en.json';
import ptBR from '../../messages/pt-BR.json';
import type { AppLocale } from './config';

/** English is the source of truth for keys; every other dictionary must have the same shape. */
export type Messages = typeof en;

/*
 * Assigning to `Messages` makes typecheck fail when pt-BR misses a key or nests it differently.
 * Extra keys and empty values are caught by `pnpm --filter @co/web check:i18n`.
 */
const ptBRMessages: Messages = ptBR;

const DICTIONARIES: Record<AppLocale, Messages> = {
  en,
  'pt-BR': ptBRMessages,
};

export function messagesFor(locale: AppLocale): Messages {
  return DICTIONARIES[locale];
}
