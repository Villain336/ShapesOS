// ShapesOS — Phase 18.1 (WS=find): per-user preferences, the pure half.
//
// Client-safe: no Prisma, no Node APIs. The settings pages, the shell (root
// layout classes, i18n) and the server store (./index.ts) all validate with
// these schemas, so a value can only ever be one the UI can render.
//
// Scope: preferences belong to the PERSON, not the workspace. They follow a
// user across every workspace they belong to (theme, language, time zone and
// motion are about the human at the keyboard), so there are no per-workspace
// overrides. Workspace-wide defaults already live with the workspace
// (Settings → Workspace → Notifications, project locale).
//
// Adding a preference: add its zod schema to PREFERENCE_SCHEMAS and its
// default to DEFAULT_PREFERENCES, add a column (or keep it inside one of the
// JSON placeholders) in prisma/schema.prisma + a migration, and map it in
// ./index.ts rowToPreferences / preferenceData. The unit test asserts every
// key has a schema and a valid default.

import { z } from "zod";

export const THEMES = ["system", "light", "dark"] as const;
export type ThemePreference = (typeof THEMES)[number];

export const CONTRASTS = ["standard", "high"] as const;
export type ContrastPreference = (typeof CONTRASTS)[number];

/** Shell languages with full catalogues (lib/i18n/messages). */
export const LANGUAGES = ["en", "es"] as const;
export type Language = (typeof LANGUAGES)[number];

export const HOUR_CYCLES = ["auto", "h12", "h23"] as const;
export type HourCycle = (typeof HOUR_CYCLES)[number];

export const DENSITIES = ["comfortable", "compact"] as const;
export type Density = (typeof DENSITIES)[number];

export const MOTIONS = ["system", "reduce"] as const;
export type MotionPreference = (typeof MOTIONS)[number];

/** Root font size in percent of the browser default (rem-based scaling). */
export const FONT_SCALES = [100, 112, 125, 150] as const;
export type FontScale = (typeof FONT_SCALES)[number];

/** Notification kinds a person can mute (prisma NotificationKind). */
export const NOTIFICATION_KINDS = [
  "approval_needed",
  "approval_decided",
  "alert_fired",
  "run_failed",
  "invite_accepted",
  // Phase 18.2 (WS=comms): Messages and Reminders.
  "mention",
  "direct_message",
  "reminder_due",
] as const;
export type NotificationKindPref = (typeof NOTIFICATION_KINDS)[number];

/** True when `tz` is an IANA time zone this runtime knows. */
export function isValidTimeZone(tz: string): boolean {
  if (!tz || tz.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Shortcuts: storage for the keyboard map (WS=desk owns the cheat-sheet and
// rebinding UI; this module owns the format and its validation).
//
// A binding is either a chord ("mod+k", "alt+shift+1", "ctrl+tab") or a
// two-step sequence of single keys ("g i"). "mod" is ⌘ on macOS and Ctrl
// elsewhere. Action ids are dotted lower-case ("command_bar.open").
// ---------------------------------------------------------------------------

const MODIFIERS = ["mod", "ctrl", "alt", "shift", "meta"] as const;
const NAMED_KEYS = new Set([
  "enter", "escape", "esc", "tab", "space", "backspace", "delete", "up", "down", "left", "right",
  "home", "end", "pageup", "pagedown", "slash", "period", "comma", "minus", "equal", "backquote",
  "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12",
]);
export const SHORTCUT_ACTION_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+){0,3}$/;
export const MAX_SHORTCUTS = 80;

export interface ParsedShortcut {
  /** Normalized text, e.g. "mod+shift+k" or "g i". */
  normalized: string;
  kind: "chord" | "sequence";
}

function isKeyToken(k: string): boolean {
  return /^[a-z0-9]$/.test(k) || NAMED_KEYS.has(k) || /^[?/\\[\];',.`=-]$/.test(k);
}

/**
 * Parse and normalize one binding. Returns null when invalid: unknown keys,
 * a modifier with no key, duplicate modifiers, a sequence longer than two
 * steps, or a bare single printable key (it would fire while typing).
 */
export function parseShortcut(raw: unknown): ParsedShortcut | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase().replace(/\s+/g, " ");
  if (!s || s.length > 40) return null;
  if (s.includes(" ") && !s.includes("+")) {
    const steps = s.split(" ");
    if (steps.length !== 2 || !steps.every((k) => /^[a-z0-9]$/.test(k))) return null;
    return { normalized: steps.join(" "), kind: "sequence" };
  }
  const parts = s.split("+").map((p) => p.trim());
  if (parts.some((p) => !p)) return null;
  const key = parts.pop()!;
  if (!isKeyToken(key)) return null;
  const mods = new Set<string>();
  for (const m of parts) {
    if (!(MODIFIERS as readonly string[]).includes(m) || mods.has(m)) return null;
    mods.add(m);
  }
  // A single printable key with no modifier (or only shift) would trigger
  // while the person types; only named keys ("escape", "f1", "?") may be bare.
  const printable = key.length === 1;
  const onlyShift = [...mods].every((m) => m === "shift");
  if (printable && onlyShift && key !== "?" && key !== "/") return null;
  const ordered = MODIFIERS.filter((m) => mods.has(m));
  return { normalized: [...ordered, key].join("+"), kind: "chord" };
}

const ShortcutsSchema = z
  .record(z.string().regex(SHORTCUT_ACTION_RE, "Unknown action id"), z.string().max(40))
  .superRefine((map, ctx) => {
    const entries = Object.entries(map);
    if (entries.length > MAX_SHORTCUTS) {
      ctx.addIssue({ code: "custom", message: `At most ${MAX_SHORTCUTS} shortcuts` });
      return;
    }
    const seen = new Map<string, string>();
    for (const [action, binding] of entries) {
      const parsed = parseShortcut(binding);
      if (!parsed) {
        ctx.addIssue({ code: "custom", path: [action], message: `"${binding}" is not a valid shortcut` });
        continue;
      }
      const other = seen.get(parsed.normalized);
      if (other) {
        ctx.addIssue({ code: "custom", path: [action], message: `"${binding}" is already used by ${other}` });
      }
      seen.set(parsed.normalized, action);
    }
  })
  .transform((map) =>
    Object.fromEntries(Object.entries(map).map(([a, b]) => [a, parseShortcut(b)?.normalized ?? b])),
  );

/** A bounded JSON object for the placeholders WS=desk and 19A fill in. */
function boundedObject(maxBytes: number) {
  return z
    .record(z.string().max(64), z.unknown())
    .refine((v) => JSON.stringify(v).length <= maxBytes, `Too large (max ${maxBytes} bytes)`);
}

export const NotificationPrefsSchema = z
  .object({
    /** The in-app bell. Off hides nothing already sent; it stops new rows. */
    inApp: z.boolean(),
    /** Mobile push (Expo) for the push kinds. */
    push: z.boolean(),
    /** Kinds muted on every channel. */
    mutedKinds: z.array(z.enum(NOTIFICATION_KINDS)).max(NOTIFICATION_KINDS.length),
  })
  .strict();
export type NotificationPrefs = z.infer<typeof NotificationPrefsSchema>;

export const PREFERENCE_SCHEMAS = {
  theme: z.enum(THEMES),
  contrast: z.enum(CONTRASTS),
  /** null = match the browser (Accept-Language), negotiated per request. */
  language: z.enum(LANGUAGES).nullable(),
  /** null = not set yet; the shell detects the device zone once and saves it. */
  timeZone: z.string().refine(isValidTimeZone, "Unknown time zone").nullable(),
  hourCycle: z.enum(HOUR_CYCLES),
  density: z.enum(DENSITIES),
  motion: z.enum(MOTIONS),
  fontScale: z.union([z.literal(100), z.literal(112), z.literal(125), z.literal(150)]),
  notifications: NotificationPrefsSchema,
  shortcuts: ShortcutsSchema,
  /** Placeholder for WS=desk (Home desktop, dock, Control Center). */
  desktop: boundedObject(16_384),
  /** Placeholder for 19A (voice on/off, voice id, push-to-talk key). */
  voice: boundedObject(4_096),
} as const;

export type PreferenceKey = keyof typeof PREFERENCE_SCHEMAS;
export const PREFERENCE_KEYS = Object.keys(PREFERENCE_SCHEMAS) as PreferenceKey[];

export type UserPreferences = { [K in PreferenceKey]: z.output<(typeof PREFERENCE_SCHEMAS)[K]> };

export const DEFAULT_PREFERENCES: UserPreferences = {
  theme: "system",
  contrast: "standard",
  language: null,
  timeZone: null,
  hourCycle: "auto",
  density: "comfortable",
  motion: "system",
  fontScale: 100,
  notifications: { inApp: true, push: true, mutedKinds: [] },
  shortcuts: {},
  desktop: {},
  voice: {},
};

export function isPreferenceKey(k: unknown): k is PreferenceKey {
  return typeof k === "string" && (PREFERENCE_KEYS as string[]).includes(k);
}

export type PreferenceResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Validate one key's value. Unknown keys are refused. */
export function validatePreference<K extends PreferenceKey>(
  key: K,
  value: unknown,
): PreferenceResult<UserPreferences[K]> {
  if (!isPreferenceKey(key)) return { ok: false, error: `Unknown preference "${String(key)}"` };
  const parsed = PREFERENCE_SCHEMAS[key].safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path?.length ? ` (${issue.path.join(".")})` : "";
    return { ok: false, error: `${key}${where}: ${issue?.message ?? "invalid value"}` };
  }
  return { ok: true, value: parsed.data as UserPreferences[K] };
}

/** A partial update: every key known and valid, or the whole patch is refused. */
export const PreferencesPatchSchema = z
  .object(Object.fromEntries(PREFERENCE_KEYS.map((k) => [k, PREFERENCE_SCHEMAS[k].optional()])) as {
    [K in PreferenceKey]: z.ZodOptional<(typeof PREFERENCE_SCHEMAS)[K]>;
  })
  .strict();
export type PreferencesPatch = Partial<UserPreferences>;

/**
 * Coerce whatever is stored (an old row, a hand-edited JSON column) into a
 * valid preferences object: each invalid field falls back to its default,
 * so a bad value can never break the shell.
 */
export function coercePreferences(stored: Partial<Record<PreferenceKey, unknown>> | null | undefined): UserPreferences {
  const out = { ...DEFAULT_PREFERENCES } as Record<PreferenceKey, unknown>;
  if (!stored) return out as UserPreferences;
  for (const key of PREFERENCE_KEYS) {
    if (!(key in stored)) continue;
    const r = validatePreference(key, stored[key]);
    if (r.ok) out[key] = r.value;
  }
  return out as UserPreferences;
}
