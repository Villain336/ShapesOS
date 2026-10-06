// ShapesOS — Phase 18.1 (WS=find): i18n for server components and routes.
//
//   const { t, locale, format } = await getI18n();
//
// The Next 16 guide's dictionary pattern (node_modules/next/dist/docs/
// 01-app/02-guides/internationalization.md): catalogues are loaded on the
// server for the request's locale; only the active one is sent to the
// client (merged over English, so nothing is ever missing).

import { cache } from "react";
import { createTranslator, en, mergeCatalogues, type Catalogue, type Translator } from "./index";
import { DEFAULT_LOCALE, type Locale } from "./locales";
import { formatDate, formatNumber, formatRelative, formatMoney, type FormatContext } from "./format";

const loaders: Record<Locale, () => Promise<Catalogue>> = {
  en: async () => en,
  es: async () => (await import("./messages/es")).es,
};

/** The full catalogue for a locale, merged over English. */
export const getCatalogue = cache(async (locale: Locale): Promise<Catalogue> => {
  if (locale === DEFAULT_LOCALE) return en;
  return mergeCatalogues(en, await loaders[locale]());
});

export interface ServerI18n {
  locale: Locale;
  messages: Catalogue;
  t: Translator;
  ctx: FormatContext;
  format: {
    date: (d: Date | string | number, style?: Parameters<typeof formatDate>[2]) => string;
    number: (n: number, opts?: Intl.NumberFormatOptions) => string;
    money: (cents: number, currency?: string) => string;
    relative: (d: Date | string | number) => string;
  };
}

export function i18nFor(locale: Locale, messages: Catalogue, ctx: Omit<FormatContext, "locale">): ServerI18n {
  const full: FormatContext = { ...ctx, locale };
  return {
    locale,
    messages,
    t: createTranslator(locale, messages),
    ctx: full,
    format: {
      date: (d, style) => formatDate(d, full, style),
      number: (n, opts) => formatNumber(n, full, opts),
      money: (cents, currency) => formatMoney(cents, full, currency),
      relative: (d) => formatRelative(d, full),
    },
  };
}

/** The request's i18n (locale + zone from the person's preferences). */
export const getI18n = cache(async (): Promise<ServerI18n> => {
  const { getShellState } = await import("@/lib/preferences/server");
  const state = await getShellState();
  const messages = await getCatalogue(state.locale);
  return i18nFor(state.locale, messages, { timeZone: state.timeZone, hourCycle: state.hourCycle });
});
