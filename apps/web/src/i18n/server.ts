import type { Metadata } from 'next';
import { cookies, headers } from 'next/headers';
import { createTranslator } from 'use-intl/core';
import { isLocale, LOCALE_COOKIE, localeFromAcceptLanguage, type AppLocale } from './config';
import { messagesFor } from './messages';

/** Server only: the active locale from the NEXT_LOCALE cookie, else from Accept-Language. */
export async function getLocale(): Promise<AppLocale> {
  const cookie = (await cookies()).get(LOCALE_COOKIE)?.value;
  if (isLocale(cookie)) return cookie;
  return localeFromAcceptLanguage((await headers()).get('accept-language'));
}

export async function getTranslator() {
  const locale = await getLocale();
  return createTranslator({ locale, messages: messagesFor(locale) });
}

export type PageTitleKey = keyof ReturnType<typeof messagesFor>['meta']['pages'];

/**
 * Localized `<title>` for a console page ("Instances · OrkStage"). The suffix is added here, as an
 * absolute title, because a title set by an intermediate layout stops the root title template
 * from reaching deeper segments. Every page inherits `noindex, nofollow` from the root layout.
 */
export async function pageMetadata(page: PageTitleKey): Promise<Metadata> {
  const t = await getTranslator();
  return { title: { absolute: `${t(`meta.pages.${page}`)} · OrkStage` } };
}
