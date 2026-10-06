// ShapesOS — Phase 18.1 (WS=desk): the UserPrefs seam for the desk.
//
// WS=find owns per-person preferences (UserPreference, lib/preferences —
// theme, language, time zone, … and the "shortcuts" and "voice" keys). Until
// that branch merges, the desk stores the two keys it writes in its own
// user_desk_state row, behind the SAME narrow interface and key names:
//
//   getUserPreferences(userId) → { shortcuts, voice, timeZone }
//   setUserPreference(userId, "shortcuts" | "voice", value)
//
// Integration: replace this file's body with a re-export of
// getUserPreferences / setUserPreference from "@/lib/preferences" (the key
// names, value shapes and the stored shortcut format already match theirs:
// lower-case "mod+shift+k" bindings keyed by dotted ids; voice is
// { enabled }), then drop user_desk_state.shortcuts / voice_enabled.
// timeZone is find's; this stub answers null (callers fall back to UTC).
//
// `userId` is always the session's own subject (routes never read it from
// the request).

import { prisma } from "@/lib/prisma";
import { SHORTCUT_ID_RE, sanitizeOverrides, toStoredBinding } from "@/lib/keyboard/shortcuts";

export interface DeskVoicePrefs {
  enabled: boolean;
}

/** The subset of WS=find's UserPreferences the desk reads and writes. */
export interface DeskPreferences {
  /** { [shortcutId]: "mod+shift+k" } — rebinding overrides (stored format). */
  shortcuts: Record<string, string>;
  voice: DeskVoicePrefs;
  /** IANA zone (WS=find); null = not known here, use UTC. */
  timeZone: string | null;
}

export type DeskPreferenceKey = "shortcuts" | "voice";

/** The narrow interface shared with WS=find's lib/preferences (same names). */
export interface UserPrefs {
  getUserPreferences(userId: string): Promise<DeskPreferences>;
  setUserPreference<K extends DeskPreferenceKey>(userId: string, key: K, value: DeskPreferences[K]): Promise<DeskPreferences>;
}

export const DEFAULT_DESK_PREFERENCES: DeskPreferences = { shortcuts: {}, voice: { enabled: false }, timeZone: null };

function assertUserId(userId: string): void {
  if (!userId || typeof userId !== "string") throw new Error("preferences: userId is required");
}

/** Stored shortcuts → the stored format, unknown/fixed/clashing entries dropped. */
function storedShortcuts(raw: unknown): Record<string, string> {
  const canonical = sanitizeOverrides(raw);
  return Object.fromEntries(Object.entries(canonical).map(([id, c]) => [id, toStoredBinding(c)]));
}

export async function getUserPreferences(userId: string): Promise<DeskPreferences> {
  assertUserId(userId);
  const row = await prisma.userDeskState.findUnique({
    where: { userId },
    select: { shortcuts: true, voiceEnabled: true },
  });
  if (!row) return { ...DEFAULT_DESK_PREFERENCES, shortcuts: {}, voice: { enabled: false } };
  return { shortcuts: storedShortcuts(row.shortcuts), voice: { enabled: row.voiceEnabled }, timeZone: null };
}

export class DeskPreferenceError extends Error {
  readonly status = 400;
}

export async function setUserPreference<K extends DeskPreferenceKey>(
  userId: string,
  key: K,
  value: DeskPreferences[K],
): Promise<DeskPreferences> {
  assertUserId(userId);
  if (key === "voice") {
    const v = value as DeskVoicePrefs;
    if (!v || typeof v.enabled !== "boolean") throw new DeskPreferenceError("voice: { enabled: boolean } expected");
    await prisma.userDeskState.upsert({
      where: { userId },
      create: { userId, voiceEnabled: v.enabled },
      update: { voiceEnabled: v.enabled },
    });
  } else if (key === "shortcuts") {
    const map = value as Record<string, string>;
    if (!map || typeof map !== "object" || Array.isArray(map)) throw new DeskPreferenceError("shortcuts: an object expected");
    for (const id of Object.keys(map)) {
      if (!SHORTCUT_ID_RE.test(id)) throw new DeskPreferenceError(`shortcuts: "${id}" is not a shortcut id`);
    }
    const clean = storedShortcuts(map);
    if (Object.keys(clean).length !== Object.keys(map).length) {
      throw new DeskPreferenceError("shortcuts: some bindings are unknown, fixed or clash with another shortcut");
    }
    await prisma.userDeskState.upsert({
      where: { userId },
      create: { userId, shortcuts: clean },
      update: { shortcuts: clean },
    });
  } else {
    throw new DeskPreferenceError(`Unknown preference "${String(key)}"`);
  }
  return getUserPreferences(userId);
}

export const deskUserPrefs: UserPrefs = { getUserPreferences, setUserPreference };
