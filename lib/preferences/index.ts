// ShapesOS — Phase 18.1 (WS=find): per-user preferences, the server store.
//
// THE INTERFACE other workstreams integrate against (WS=desk reads shortcuts
// and theme through it; 19A will read voice):
//
//   interface UserPrefs {
//     getUserPreferences(userId): Promise<UserPreferences>
//     setUserPreference(userId, key, value): Promise<UserPreferences>
//   }
//
// Keys and values are validated by lib/preferences/schema.ts (zod): an
// unknown key or an invalid value throws PreferenceError and nothing is
// written. Reads never throw on stored data — an invalid stored field falls
// back to its default (coercePreferences).
//
// Ownership: `userId` must be the SESSION's own subject. Routes take it from
// requireSelfService(), never from the request (app/api/preferences).

import { cache } from "react";
import type { Prisma, UserPreference } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  coercePreferences,
  DEFAULT_PREFERENCES,
  isPreferenceKey,
  PreferencesPatchSchema,
  validatePreference,
  type PreferenceKey,
  type PreferencesPatch,
  type UserPreferences,
} from "./schema";

export * from "./schema";

export class PreferenceError extends Error {
  readonly status = 400;
}

/** The narrow interface WS=desk (and later 19A) import. */
export interface UserPrefs {
  getUserPreferences(userId: string): Promise<UserPreferences>;
  setUserPreference<K extends PreferenceKey>(userId: string, key: K, value: UserPreferences[K]): Promise<UserPreferences>;
}

type PrefDb = Pick<Prisma.TransactionClient, "userPreference">;

function rowToPreferences(row: UserPreference | null): UserPreferences {
  if (!row) return { ...DEFAULT_PREFERENCES };
  return coercePreferences({
    theme: row.theme,
    contrast: row.contrast,
    language: row.language,
    timeZone: row.timeZone,
    hourCycle: row.hourCycle,
    density: row.density,
    motion: row.motion,
    fontScale: row.fontScale,
    // An empty JSON object means "never set": keep the default.
    ...(isNonEmptyObject(row.notifications) ? { notifications: row.notifications } : {}),
    shortcuts: row.shortcuts,
    desktop: row.desktop,
    voice: row.voice,
  });
}

function isNonEmptyObject(v: unknown): boolean {
  return !!v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length > 0;
}

/** Column data for a validated patch (keys map 1:1 to columns). */
function preferenceData(patch: PreferencesPatch): Prisma.UserPreferenceUpdateInput {
  const data: Prisma.UserPreferenceUpdateInput = {};
  for (const [key, value] of Object.entries(patch) as [PreferenceKey, unknown][]) {
    if (value === undefined) continue;
    (data as Record<string, unknown>)[key] = value as Prisma.InputJsonValue;
  }
  return data;
}

function assertUserId(userId: string): void {
  if (typeof userId !== "string" || !userId.trim() || userId.length > 200) {
    throw new PreferenceError("A signed-in user is required");
  }
}

/** Everything for one person; defaults when they never saved anything. */
export async function getUserPreferences(userId: string, db: PrefDb = prisma): Promise<UserPreferences> {
  assertUserId(userId);
  const row = await db.userPreference.findUnique({ where: { userId } });
  return rowToPreferences(row);
}

/** Request-scoped read for the layout + pages (one query per request). */
export const getUserPreferencesCached = cache((userId: string) => getUserPreferences(userId));

/**
 * Validate and save a partial update (all-or-nothing). Returns the full,
 * updated preferences.
 */
export async function setUserPreferences(userId: string, patch: unknown, db: PrefDb = prisma): Promise<UserPreferences> {
  assertUserId(userId);
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new PreferenceError("Send an object of preference keys and values");
  }
  for (const k of Object.keys(patch)) {
    if (!isPreferenceKey(k)) throw new PreferenceError(`Unknown preference "${k}"`);
  }
  const parsed = PreferencesPatchSchema.safeParse(patch);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new PreferenceError(`${issue?.path?.join(".") || "preferences"}: ${issue?.message ?? "invalid value"}`);
  }
  const data = preferenceData(parsed.data as PreferencesPatch);
  if (Object.keys(data).length === 0) return getUserPreferences(userId, db);
  const row = await db.userPreference.upsert({
    where: { userId },
    create: { ...(data as Omit<Prisma.UserPreferenceCreateInput, "userId">), userId },
    update: data,
  });
  return rowToPreferences(row);
}

/** Validate and save one key. Throws PreferenceError for an unknown key or a bad value. */
export async function setUserPreference<K extends PreferenceKey>(
  userId: string,
  key: K,
  value: UserPreferences[K],
  db: PrefDb = prisma,
): Promise<UserPreferences> {
  if (!isPreferenceKey(key)) throw new PreferenceError(`Unknown preference "${String(key)}"`);
  const checked = validatePreference(key, value);
  if (!checked.ok) throw new PreferenceError(checked.error);
  return setUserPreferences(userId, { [key]: checked.value }, db);
}

/** The default implementation of the shared interface. */
export const userPrefs: UserPrefs = {
  getUserPreferences: (userId) => getUserPreferences(userId),
  setUserPreference: (userId, key, value) => setUserPreference(userId, key, value),
};

/**
 * Keep the notification inputs whose recipient allows this channel and kind
 * (lib/notifications/producers.ts calls it for the bell, then for push).
 */
export async function filterByNotificationPrefs<T extends { userId: string; kind: string }>(
  inputs: readonly T[],
  channel: "inApp" | "push",
  db: PrefDb = prisma,
): Promise<T[]> {
  if (inputs.length === 0) return [];
  const byKind = new Map<string, string[]>();
  for (const n of inputs) byKind.set(n.kind, [...(byKind.get(n.kind) ?? []), n.userId]);
  const allowed = new Map<string, Set<string>>();
  for (const [kind, users] of byKind) allowed.set(kind, await recipientsAllowing(users, channel, kind, db));
  return inputs.filter((n) => allowed.get(n.kind)?.has(n.userId));
}

/**
 * Notification channel filter: drops rows for people who switched the
 * channel off or muted the kind. Never throws; on a read error everything
 * passes (a preference lookup must never swallow an approval request).
 */
export async function recipientsAllowing(
  userIds: readonly string[],
  channel: "inApp" | "push",
  kind: string,
  db: PrefDb = prisma,
): Promise<Set<string>> {
  const all = new Set(userIds);
  if (all.size === 0) return all;
  try {
    const rows = await db.userPreference.findMany({ where: { userId: { in: [...all] } } });
    for (const row of rows) {
      const p = rowToPreferences(row);
      if (!p.notifications[channel] || (p.notifications.mutedKinds as string[]).includes(kind)) all.delete(row.userId);
    }
  } catch {
    // fail open: deliver
  }
  return all;
}
