import type { Locale } from './config';
import { en, type Messages } from './messages/en';
import { ptBR } from './messages/pt-br';

export * from './config';
export type { Messages };

const dictionaries: Record<Locale, Messages> = { en, 'pt-BR': ptBR };

export function getMessages(locale: Locale): Messages {
  return dictionaries[locale];
}
