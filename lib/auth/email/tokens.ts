// ShapesOS — email-account identity + one-time link tokens (Phase 6). Pure.
//
//   normalizeEmail   trim + lower-case + shape check (≤ 254 chars). The whole
//                    address is lower-cased, matching every other email
//                    comparison in the app (invites, SCIM, signup mode).
//   emailUserId      the account's stable Auth.js subject: "email:<email>",
//                    next to "admin:<email>" and "<provider>:<accountId>".
//   tokens           32 random bytes, base64url (43 chars) in the link; only
//                    their SHA-256 (hex) is stored. 256-bit tokens make a
//                    salted/slow hash unnecessary: the hash only stops a
//                    database reader from using a live link.

import { createHash, randomBytes } from "node:crypto";

export const EMAIL_USER_ID_PREFIX = "email:";
export const MAX_EMAIL_LENGTH = 254;

export type EmailTokenPurpose = "verify" | "login" | "reset";

/** How long each kind of link works. */
export const TOKEN_TTL_MS: Record<EmailTokenPurpose, number> = {
  verify: 24 * 60 * 60 * 1000,
  login: 15 * 60 * 1000,
  reset: 60 * 60 * 1000,
};

/** At most this many links per address per window (anti mail-bombing). */
export const EMAIL_SEND_LIMIT = 5;
export const EMAIL_SEND_WINDOW_MS = 15 * 60 * 1000;

// Deliberately simple: one "@", a non-empty local part without spaces, and a
// dotted domain. Real validation is the link arriving.
const EMAIL_SHAPE = /^[^\s@"<>()[\]\\,;:]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const e = raw.normalize("NFC").trim().toLowerCase();
  if (!e || e.length > MAX_EMAIL_LENGTH) return null;
  const local = e.split("@")[0] ?? "";
  if (local.length > 64 || local.startsWith(".") || local.endsWith(".") || local.includes("..")) return null;
  return EMAIL_SHAPE.test(e) ? e : null;
}

export function emailUserId(normalizedEmail: string): string {
  return EMAIL_USER_ID_PREFIX + normalizedEmail;
}

export function isEmailUserId(userId: string | null | undefined): boolean {
  return typeof userId === "string" && userId.startsWith(EMAIL_USER_ID_PREFIX) && userId.length > EMAIL_USER_ID_PREFIX.length;
}

/** The address behind an "email:" subject, or null for any other subject. */
export function emailFromUserId(userId: string | null | undefined): string | null {
  return isEmailUserId(userId) ? userId!.slice(EMAIL_USER_ID_PREFIX.length) : null;
}

export function generateEmailToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Shape check before touching the database (43 base64url chars). */
export function looksLikeEmailToken(token: unknown): token is string {
  return typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token);
}

export function hashEmailToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function tokenExpiry(purpose: EmailTokenPurpose, now: Date = new Date()): Date {
  return new Date(now.getTime() + TOKEN_TTL_MS[purpose]);
}

/** Display name: what they typed (trimmed, ≤ 80), else null. */
export function cleanName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const n = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return n ? n.slice(0, 80) : null;
}
