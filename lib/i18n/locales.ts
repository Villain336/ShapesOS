// ShapesOS — Phase 18.1 (WS=find): supported locales and negotiation.
//
// Approach (read node_modules/next/dist/docs/01-app/02-guides/
// internationalization.md first): the Next 16 guide's localization pattern —
// per-locale dictionaries loaded on the server, the locale picked from the
// person's preference or, failing that, the Accept-Language header. We do
// NOT move the app under an app/[lang] segment: the dashboard is signed-in,
// never indexed, and its language is a per-person preference that must
// follow them across devices, so it comes from UserPreference (with
// Accept-Language as the fallback) rather than from the URL. Pure.

import { LANGUAGES, type Language } from "@/lib/preferences/schema";

export type Locale = Language;
export const LOCALES: readonly Locale[] = LANGUAGES;
export const DEFAULT_LOCALE: Locale = "en";

/** BCP 47 tag used for Intl formatting of each locale. */
export const INTL_LOCALE: Record<Locale, string> = { en: "en-US", es: "es-ES" };

export function isLocale(v: unknown): v is Locale {
  return typeof v === "string" && (LOCALES as readonly string[]).includes(v);
}

/**
 * Pick the best supported locale from an Accept-Language header
 * ("es-MX,es;q=0.9,en;q=0.8" → "es"). Ties keep header order; anything
 * unparseable falls back to the default.
 */
export function negotiateLocale(acceptLanguage: string | null | undefined): Locale {
  if (!acceptLanguage) return DEFAULT_LOCALE;
  const ranked = acceptLanguage
    .slice(0, 500)
    .split(",")
    .map((part, idx) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      const weight = q ? Number(q.slice(2)) : 1;
      return { base: (tag ?? "").toLowerCase().split("-")[0] ?? "", weight: Number.isFinite(weight) ? weight : 0, idx };
    })
    .filter((x) => x.base && x.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.idx - b.idx);
  for (const r of ranked) if (isLocale(r.base)) return r.base;
  return DEFAULT_LOCALE;
}
