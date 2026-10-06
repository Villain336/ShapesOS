"use client";

// ShapesOS — Phase 18.1 (WS=find): i18n for client components.
//
//   const { t, locale, format } = useI18n();
//
// The root layout mounts <I18nProvider> with the request's locale, the
// person's time zone and clock, and the active catalogue (already merged over
// English on the server). Outside a provider (tests, isolated renders) the
// hook falls back to English + UTC, so components never crash on a missing
// provider.

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { createTranslator, en, navText, settingsPageText, type Catalogue, type Translator } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n/locales";
import { formatDate, formatMoney, formatNumber, formatRelative, type FormatContext } from "@/lib/i18n/format";
import type { HourCycle } from "@/lib/preferences/schema";

export interface ClientI18n {
  locale: Locale;
  messages: Catalogue;
  t: Translator;
  ctx: FormatContext;
  nav: (href: string, fallback: { label: string; description: string }) => { label: string; description: string };
  settingsPage: (href: string, fallback: { label: string; description: string }) => { label: string; description: string };
  format: {
    date: (d: Date | string | number, style?: Parameters<typeof formatDate>[2]) => string;
    number: (n: number, opts?: Intl.NumberFormatOptions) => string;
    money: (cents: number, currency?: string) => string;
    relative: (d: Date | string | number) => string;
  };
}

function build(locale: Locale, messages: Catalogue, timeZone: string | null, hourCycle: HourCycle): ClientI18n {
  const ctx: FormatContext = { locale, timeZone, hourCycle };
  return {
    locale,
    messages,
    t: createTranslator(locale, messages),
    ctx,
    nav: (href, fallback) => {
      const m = navText(messages, href);
      return { label: m.label ?? fallback.label, description: m.description ?? fallback.description };
    },
    settingsPage: (href, fallback) => {
      const m = settingsPageText(messages, href);
      return { label: m.label ?? fallback.label, description: m.description ?? fallback.description };
    },
    format: {
      date: (d, style) => formatDate(d, ctx, style),
      number: (n, opts) => formatNumber(n, ctx, opts),
      money: (cents, currency) => formatMoney(cents, ctx, currency),
      relative: (d) => formatRelative(d, ctx),
    },
  };
}

const DEFAULT_I18N = build("en", en, null, "auto");
const I18nContext = createContext<ClientI18n>(DEFAULT_I18N);

export function I18nProvider({
  locale,
  messages,
  timeZone,
  hourCycle,
  children,
}: {
  locale: Locale;
  /** The active catalogue merged over English; omitted for English. */
  messages?: Catalogue;
  timeZone: string | null;
  hourCycle: HourCycle;
  children: ReactNode;
}) {
  const value = useMemo(() => build(locale, messages ?? en, timeZone, hourCycle), [locale, messages, timeZone, hourCycle]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): ClientI18n {
  return useContext(I18nContext);
}

/** Shorthand when only `t` is needed. */
export function useT(): Translator {
  return useContext(I18nContext).t;
}
