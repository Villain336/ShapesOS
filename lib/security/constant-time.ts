// ShapesOS — constant-time secret comparison (Phase 1).
//
// `===` on a secret leaks how many leading characters matched through
// timing. Both sides are SHA-256'd first so inputs of any length compare in
// constant time without leaking the secret's length.

import { createHash, timingSafeEqual } from "node:crypto";

/** Constant-time string equality. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

/**
 * True when `authorizationHeader` is exactly `Bearer <secret>`. An unset or
 * blank secret never matches (fail closed).
 */
export function bearerMatches(authorizationHeader: string | null | undefined, secret: string | null | undefined): boolean {
  const s = (secret ?? "").trim();
  if (!s) return false;
  return safeEqual(authorizationHeader ?? "", `Bearer ${s}`);
}
