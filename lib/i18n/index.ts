// ShapesOS — Phase 18.1 (WS=find): the typed translator.
//
//   const t = createTranslator("es", messages);
//   t("shell.newTask")                          → "Nueva tarea"
//   t("commandBar.results", { count: 3 })       → "3 resultados"
//
// Keys are type-checked against the English catalogue (MessageKey), so a
// typo fails `npm run typecheck`. Client-safe: only English is bundled
// here (the default and the fallback); other locales are loaded on the
// server (lib/i18n/server.ts) and handed to the client provider already
// merged over English, so a missing translation shows English, never a key.
//
// Client components: `const { t } = useI18n()` (components/i18n/I18nProvider).
// Server components: `const { t } = await getI18n()` (lib/i18n/server.ts).

import { en, type Catalogue } from "./messages/en";
import { formatIcu, type MessageValues } from "./icu";
import { DEFAULT_LOCALE, type Locale } from "./locales";

export { en };
export type { Catalogue };
export type { Locale } from "./locales";
export type { MessageValues } from "./icu";

type Leaves<T, P extends string = ""> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : Leaves<T[K], `${P}${K}.`>;
}[keyof T & string];

/** Every translatable key, e.g. "shell.newTask" or "nav.groups.grow". */
export type MessageKey = Leaves<typeof en>;

export type Translator = (key: MessageKey, values?: MessageValues) => string;

/** Look up a dotted path; undefined when any segment is missing. */
export function lookup(messages: unknown, key: string): string | undefined {
  // Path-keyed entries ("nav.items./dashboard/crm.label") split correctly:
  // hrefs never contain a dot.
  let node: unknown = messages;
  for (const part of key.split(".")) {
    if (!node || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string" ? node : undefined;
}

/** Deep-merge `over` onto `base` (string leaves only): the fallback chain. */
export function mergeCatalogues<T>(base: T, over: unknown): T {
  if (!over || typeof over !== "object") return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    const b = out[k];
    if (typeof v === "string" && typeof b === "string") out[k] = v;
    else if (v && typeof v === "object" && b && typeof b === "object") out[k] = mergeCatalogues(b, v);
  }
  return out as T;
}

/**
 * A translator over `messages` (already merged over English). An unknown key
 * renders the key itself — loud in review, never a crash.
 */
export function createTranslator(locale: Locale = DEFAULT_LOCALE, messages: Catalogue = en): Translator {
  return (key, values) => {
    const src = lookup(messages, key) ?? lookup(en, key);
    if (src === undefined) return key;
    try {
      return formatIcu(src, values, locale);
    } catch {
      return src;
    }
  };
}

/** Nav item label/description in the active catalogue (falls back to the given English). */
export function navText(messages: Catalogue, href: string): { label?: string; description?: string } {
  const items = (messages.nav.items as Record<string, { label: string; description: string } | undefined>) ?? {};
  return items[href] ?? {};
}

/** Settings page label/description in the active catalogue. */
export function settingsPageText(messages: Catalogue, href: string): { label?: string; description?: string } {
  const pages = (messages.settings.pages as Record<string, { label: string; description: string } | undefined>) ?? {};
  return pages[href] ?? {};
}
