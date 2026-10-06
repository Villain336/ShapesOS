// ShapesOS — Phase 18.1: the desk's view of the person's preferences.
//
// Per-person preferences live in ONE place: WS=find's UserPreference
// (lib/preferences — theme, language, time zone, … and the "shortcuts" and
// "voice" keys). This file is a thin ADAPTER over that store (it holds no
// data of its own; user_desk_state keeps only focus / do not disturb, which
// is state, not a preference):
//
//   getUserPreferences(userId) → { shortcuts, voice, timeZone }
//   setUserPreference(userId, "shortcuts" | "voice", value)
//
// What the adapter adds on top of lib/preferences' own validation:
//   - shortcuts are checked against the keyboard REGISTRY
//     (lib/keyboard/shortcuts.ts): an unknown id, a fixed shortcut, a clash
//     with another live shortcut or a reserved browser combo is refused on
//     write and dropped on read (a binding saved through PATCH
//     /api/preferences, which only checks the format, can never break the
//     keyboard host);
//   - voice is read as { enabled } and written by merging into the stored
//     voice object, so fields 19A adds there survive a toggle.
//
// `userId` is always the session's own subject (routes never read it from
// the request).

import {
  getUserPreferences as getStoredPreferences,
  PreferenceError,
  setUserPreference as setStoredPreference,
} from "@/lib/preferences";
import { SHORTCUT_ID_RE, sanitizeOverrides, toStoredBinding } from "@/lib/keyboard/shortcuts";

export interface DeskVoicePrefs {
  enabled: boolean;
}

/** The subset of the person's UserPreferences the desk reads and writes. */
export interface DeskPreferences {
  /** { [shortcutId]: "mod+shift+k" } — rebinding overrides (stored format). */
  shortcuts: Record<string, string>;
  voice: DeskVoicePrefs;
  /** IANA zone from the person's preferences; null = not set yet (callers use UTC). */
  timeZone: string | null;
}

export type DeskPreferenceKey = "shortcuts" | "voice";

/** The narrow interface the desk uses (same names as lib/preferences' UserPrefs). */
export interface UserPrefs {
  getUserPreferences(userId: string): Promise<DeskPreferences>;
  setUserPreference<K extends DeskPreferenceKey>(userId: string, key: K, value: DeskPreferences[K]): Promise<DeskPreferences>;
}

export const DEFAULT_DESK_PREFERENCES: DeskPreferences = { shortcuts: {}, voice: { enabled: false }, timeZone: null };

export class DeskPreferenceError extends Error {
  readonly status = 400;
}

/** Stored shortcuts → the stored format, unknown/fixed/clashing entries dropped. */
function storedShortcuts(raw: unknown): Record<string, string> {
  const canonical = sanitizeOverrides(raw);
  return Object.fromEntries(Object.entries(canonical).map(([id, c]) => [id, toStoredBinding(c)]));
}

function voiceEnabled(voice: Record<string, unknown> | null | undefined): boolean {
  return voice?.enabled === true;
}

function toDesk(p: { shortcuts: unknown; voice: Record<string, unknown>; timeZone: string | null }): DeskPreferences {
  return { shortcuts: storedShortcuts(p.shortcuts), voice: { enabled: voiceEnabled(p.voice) }, timeZone: p.timeZone };
}

export async function getUserPreferences(userId: string): Promise<DeskPreferences> {
  try {
    return toDesk(await getStoredPreferences(userId));
  } catch (err) {
    if (err instanceof PreferenceError) throw new DeskPreferenceError(err.message);
    throw err;
  }
}

export async function setUserPreference<K extends DeskPreferenceKey>(
  userId: string,
  key: K,
  value: DeskPreferences[K],
): Promise<DeskPreferences> {
  try {
    if (key === "voice") {
      const v = value as DeskVoicePrefs;
      if (!v || typeof v.enabled !== "boolean") throw new DeskPreferenceError("voice: { enabled: boolean } expected");
      const current = await getStoredPreferences(userId);
      return toDesk(await setStoredPreference(userId, "voice", { ...current.voice, enabled: v.enabled }));
    }
    if (key === "shortcuts") {
      const map = value as Record<string, string>;
      if (!map || typeof map !== "object" || Array.isArray(map)) throw new DeskPreferenceError("shortcuts: an object expected");
      for (const id of Object.keys(map)) {
        if (!SHORTCUT_ID_RE.test(id)) throw new DeskPreferenceError(`shortcuts: "${id}" is not a shortcut id`);
      }
      const clean = storedShortcuts(map);
      if (Object.keys(clean).length !== Object.keys(map).length) {
        throw new DeskPreferenceError("shortcuts: some bindings are unknown, fixed or clash with another shortcut");
      }
      return toDesk(await setStoredPreference(userId, "shortcuts", clean));
    }
    throw new DeskPreferenceError(`Unknown preference "${String(key)}"`);
  } catch (err) {
    if (err instanceof PreferenceError) throw new DeskPreferenceError(err.message);
    throw err;
  }
}

export const deskUserPrefs: UserPrefs = { getUserPreferences, setUserPreference };
