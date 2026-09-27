// Marketr — Phase 11 "Canvas": share-token helpers (Feature 6).
// Only SHA-256 hashes are persisted; raw tokens are returned once at
// creation and never stored, logged, or emailed.

import { createHash, randomBytes } from "node:crypto";

/** 32 random bytes → URL-safe base64 (43 chars, no padding). */
export function newShareToken(): string {
  return randomBytes(32).toString("base64url");
}

/** SHA-256 hex of the token — this is what goes in the DB. */
export function hashShareToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function shareUrl(origin: string, token: string): string {
  return `${origin.replace(/\/$/, "")}/s/${token}`;
}
