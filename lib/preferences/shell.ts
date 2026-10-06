// ShapesOS — Phase 18.1 (WS=find): how preferences reach the page.
//
// The root layout renders <html> with these classes server-side, so the
// first paint is already in the person's theme, contrast, size, density and
// motion setting (no flash, no client script). Pure and client-safe: the
// Appearance page uses the same function to preview a change instantly.
//
//   theme-light | theme-dark | theme-system   which token set applies
//                                             (theme-system follows
//                                             prefers-color-scheme in CSS)
//   dark                                      the Tailwind `dark:` variant and
//                                             the dark token set (explicit dark)
//   contrast-high                             the high-contrast token set
//   density-compact                           tighter shell rows and gutters
//   motion-reduce                             the reduced-motion rules, even
//                                             when the OS doesn't ask for them
//   font-scale-112 | -125 | -150              root font size (rem scaling)
//
// app/globals.css and docs/design/tokens.css hold the token sets; DESIGN.md
// documents them. A cookie carries the same few values for signed-out pages
// (login, signup) so they match the last signed-in look on this device.

import {
  CONTRASTS,
  DENSITIES,
  FONT_SCALES,
  LANGUAGES,
  MOTIONS,
  THEMES,
  type ContrastPreference,
  type Density,
  type FontScale,
  type Language,
  type MotionPreference,
  type ThemePreference,
  type UserPreferences,
} from "./schema";

/** The subset of preferences the shell paints with (also the cookie payload). */
export interface ShellPreferences {
  theme: ThemePreference;
  contrast: ContrastPreference;
  density: Density;
  motion: MotionPreference;
  fontScale: FontScale;
  language: Language | null;
}

export const DEFAULT_SHELL: ShellPreferences = {
  theme: "system",
  contrast: "standard",
  density: "comfortable",
  motion: "system",
  fontScale: 100,
  language: null,
};

export function shellFrom(p: Pick<UserPreferences, keyof ShellPreferences>): ShellPreferences {
  return {
    theme: p.theme,
    contrast: p.contrast,
    density: p.density,
    motion: p.motion,
    fontScale: p.fontScale,
    language: p.language,
  };
}

/** Class list for <html>. Stable order (tested). */
export function shellClassNames(p: ShellPreferences): string[] {
  const out = [`theme-${p.theme}`];
  if (p.theme === "dark") out.push("dark");
  if (p.contrast === "high") out.push("contrast-high");
  if (p.density === "compact") out.push("density-compact");
  if (p.motion === "reduce") out.push("motion-reduce");
  if (p.fontScale !== 100) out.push(`font-scale-${p.fontScale}`);
  return out;
}

/** Every class shellClassNames can produce (the client strips these before re-applying). */
export const SHELL_CLASS_PREFIXES = ["theme-", "contrast-", "density-", "motion-", "font-scale-"] as const;

/** `color-scheme` for <html>: lets native controls and scrollbars match. */
export function colorScheme(p: Pick<ShellPreferences, "theme">): "light" | "dark" | "light dark" {
  return p.theme === "system" ? "light dark" : p.theme;
}

// ---------------------------------------------------------------------------
// Cookie: "t=dark;c=high;d=compact;m=reduce;f=125;l=es" — short, no PII.
// ---------------------------------------------------------------------------

export const SHELL_COOKIE = "shapes_shell";
export const SHELL_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function encodeShellCookie(p: ShellPreferences): string {
  return [`t=${p.theme}`, `c=${p.contrast}`, `d=${p.density}`, `m=${p.motion}`, `f=${p.fontScale}`, `l=${p.language ?? "auto"}`].join(";");
}

/** Parse the cookie; anything unknown or malformed falls back to the default. */
export function decodeShellCookie(raw: string | null | undefined): ShellPreferences {
  const out: ShellPreferences = { ...DEFAULT_SHELL };
  if (!raw || raw.length > 200) return out;
  for (const part of raw.split(";")) {
    const [k, v] = part.split("=");
    if (!k || v === undefined) continue;
    if (k === "t" && (THEMES as readonly string[]).includes(v)) out.theme = v as ThemePreference;
    else if (k === "c" && (CONTRASTS as readonly string[]).includes(v)) out.contrast = v as ContrastPreference;
    else if (k === "d" && (DENSITIES as readonly string[]).includes(v)) out.density = v as Density;
    else if (k === "m" && (MOTIONS as readonly string[]).includes(v)) out.motion = v as MotionPreference;
    else if (k === "f" && (FONT_SCALES as readonly number[]).includes(Number(v))) out.fontScale = Number(v) as FontScale;
    else if (k === "l" && (LANGUAGES as readonly string[]).includes(v)) out.language = v as Language;
  }
  return out;
}
