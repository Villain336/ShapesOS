// Marketr — metering wiring helpers (Phase C gaps, G1).
//
// Small pure helpers shared by charge points so idempotency and rounding
// rules are defined once, tested once, and can't drift per call site.

import { createHash } from "node:crypto";

/**
 * UTC hour bucket, e.g. "2026-09-22T22".
 *
 * Used in idempotency keys for actions with no domain row (keyword_ideas,
 * keyword_gap and their chat-tool equivalents). Documented tradeoff (T12):
 * retries/double-clicks within the same UTC hour dedup to one charge;
 * genuinely repeated use an hour later charges again. We under-charge on
 * repeats rather than risk double-charging on retry.
 */
export function hourBucket(d: Date = new Date()): string {
  return d.toISOString().slice(0, 13);
}

/** Short stable hash for embedding user input in idempotency keys. */
export function seedHash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

/**
 * Whole GB over quota, rounded up. 1 GB = 1_000_000_000 bytes (decimal,
 * matching common hosting-billing convention).
 *
 * HONEST APPROXIMATION (T11): callers pass a point-in-time usedBytes
 * snapshot — this is NOT a time-weighted average. A workspace that spikes
 * over quota and cleans up before the monthly cron runs is never charged;
 * sustained over-quota usage is charged on the snapshot.
 */
export function gbOverQuota(
  usedBytes: bigint | number,
  limitBytes: bigint | number,
): number {
  const over = BigInt(usedBytes) - BigInt(limitBytes);
  if (over <= BigInt(0)) return 0;
  return Number((over + BigInt(999_999_999)) / BigInt(1_000_000_000));
}
