// Marketr — Phase 10 M1: rank-check cadence policy.
//
// TICO DECISION (SPEC-PHASE10 §10 Q3, locked 2026-09-26): long-tail tracked
// keywords stay on WEEKLY checks (margin lever declined; refresh cadence
// wins). Head terms check daily.
//
// This module is the single source of truth for that default. The scheduler
// consumer (POST /api/rankings/check, DEPLOY.md cron lines) calls
// `isCheckDue()` before spending a paid SERP call on a tracked keyword.
// No Prisma schema change: Keyword has no cadence column, so the policy is
// derived per-keyword from phrase/volume at schedule time.
//
// Long-tail heuristic (documented, tunable):
//   - 4+ words in the phrase, OR
//   - known search volume below LONG_TAIL_VOLUME_MAX (500).
// Either signal classifies the keyword as long-tail → weekly cadence.

export type CheckCadence = "weekly" | "daily";

/** 4+ word phrases read as long-tail even when volume is unknown. */
export const LONG_TAIL_WORD_COUNT = 4;
/** Volume below this (when known) reads as long-tail. */
export const LONG_TAIL_VOLUME_MAX = 500;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface CadenceKeyword {
  phrase: string;
  /** Null/undefined = volume unknown; falls back to the word-count signal. */
  volume?: number | null;
}

/** True when the keyword reads as long-tail per the documented heuristic. */
export function isLongTailKeyword(kw: CadenceKeyword): boolean {
  const words = kw.phrase.trim().split(/\s+/).filter(Boolean).length;
  if (words >= LONG_TAIL_WORD_COUNT) return true;
  if (typeof kw.volume === "number" && kw.volume >= 0 && kw.volume < LONG_TAIL_VOLUME_MAX) {
    return true;
  }
  return false;
}

/**
 * Scheduler default per keyword. Long-tail → "weekly" (the Tico-locked
 * default); everything else → "daily". Explicit per-keyword overrides (if a
 * scheduler ever stores one) take precedence over this default — callers
 * should check overrides first and fall back to this.
 */
export function checkCadence(kw: CadenceKeyword): CheckCadence {
  return isLongTailKeyword(kw) ? "weekly" : "daily";
}

/**
 * True when a keyword's rank check is due. A keyword with no recorded check
 * is always due. Weekly cadence = 7 days since last check; daily = 24h.
 */
export function isCheckDue(
  kw: CadenceKeyword,
  lastCheckedAt: Date | null,
  now: Date = new Date(),
): boolean {
  if (!lastCheckedAt) return true;
  const intervalMs = checkCadence(kw) === "weekly" ? 7 * DAY_MS : DAY_MS;
  return now.getTime() - lastCheckedAt.getTime() >= intervalMs;
}
