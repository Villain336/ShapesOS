// ShapesOS — Phase 18.1 (WS=find): the request's shell state (server only).
//
// One read per request (React cache): the signed-in person's preferences,
// or — signed out, or when the read fails — the `shapes_shell` cookie this
// device got the last time someone saved preferences here. The language
// falls back to the Accept-Language header (lib/i18n/locales.ts). The root
// layout paints <html> from this, so the first byte is already right.

import { cache } from "react";
import { DEFAULT_PREFERENCES, type HourCycle, type UserPreferences } from "./schema";
import { decodeShellCookie, SHELL_COOKIE, type ShellPreferences } from "./shell";
import { negotiateLocale, type Locale } from "@/lib/i18n/locales";

export interface ShellState {
  shell: ShellPreferences;
  locale: Locale;
  timeZone: string | null;
  hourCycle: HourCycle;
  /** True when the preferences came from the signed-in person's row. */
  signedIn: boolean;
  /** The full preferences when signed in (else the defaults). */
  preferences: UserPreferences;
}

async function requestHeaders(): Promise<{ cookie: string | null; acceptLanguage: string | null }> {
  try {
    const { cookies, headers } = await import("next/headers");
    const [c, h] = await Promise.all([cookies(), headers()]);
    return { cookie: c.get(SHELL_COOKIE)?.value ?? null, acceptLanguage: h.get("accept-language") };
  } catch {
    return { cookie: null, acceptLanguage: null };
  }
}

export const getShellState = cache(async (): Promise<ShellState> => {
  const { cookie, acceptLanguage } = await requestHeaders();
  const fromCookie = decodeShellCookie(cookie);
  let preferences: UserPreferences = { ...DEFAULT_PREFERENCES, ...fromCookie };
  let signedIn = false;
  try {
    const { requireUser } = await import("@/lib/session");
    const user = await requireUser();
    if (user?.id) {
      const { getUserPreferencesCached } = await import("./index");
      preferences = await getUserPreferencesCached(user.id);
      signedIn = true;
    }
  } catch {
    // Database or auth unavailable: paint from the cookie; never fail a page.
  }
  const shell: ShellPreferences = {
    theme: preferences.theme,
    contrast: preferences.contrast,
    density: preferences.density,
    motion: preferences.motion,
    fontScale: preferences.fontScale,
    language: preferences.language,
  };
  return {
    shell,
    locale: preferences.language ?? negotiateLocale(acceptLanguage),
    timeZone: preferences.timeZone,
    hourCycle: preferences.hourCycle,
    signedIn,
    preferences,
  };
});
