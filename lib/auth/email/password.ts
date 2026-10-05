// ShapesOS — password hashing + policy for email accounts (Phase 6).
//
// Hashing: scrypt from node:crypto with explicit, stored parameters:
//
//   scrypt$<N>$<r>$<p>$<salt base64url>$<hash base64url>
//
// N=2^15, r=8, p=1 (32 MiB of memory per hash), 16-byte random salt, 32-byte
// key. The parameters travel with the hash, so they can be raised later
// (needsRehash) without breaking existing accounts. Verification recomputes
// with the stored parameters and compares with crypto.timingSafeEqual.
//
// Policy (no external breach API): 10–256 characters, not one of a short list
// of very common passwords, and not the email address or its local part.
// Nothing here logs a password or a hash.

import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";

export const SCRYPT_PARAMS = { N: 2 ** 15, r: 8, p: 1 } as const;
export const SCRYPT_KEY_LENGTH = 32;
export const SCRYPT_SALT_BYTES = 16;
/** Bounds on stored parameters we're willing to evaluate (a tampered row can't make us burn the CPU). */
const MAX_N = 2 ** 20;
const MAX_R = 32;
const MAX_P = 16;

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 256;

function scrypt(password: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password.normalize("NFKC"), salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** Memory scrypt needs for these parameters, with headroom (Node's default cap is 32 MiB). */
function maxmemFor(N: number, r: number): number {
  return 128 * N * r * 2;
}

export async function hashPassword(password: string): Promise<string> {
  const { N, r, p } = SCRYPT_PARAMS;
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const key = await scrypt(password, salt, SCRYPT_KEY_LENGTH, { N, r, p, maxmem: maxmemFor(N, r) });
  return ["scrypt", N, r, p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

interface ParsedHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  key: Buffer;
}

export function parsePasswordHash(stored: string | null | undefined): ParsedHash | null {
  if (typeof stored !== "string") return null;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;
  const [N, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  if (![N, r, p].every((n) => Number.isInteger(n) && n > 0)) return null;
  if (N > MAX_N || (N & (N - 1)) !== 0 || r > MAX_R || p > MAX_P) return null;
  const salt = Buffer.from(parts[4]!, "base64url");
  const key = Buffer.from(parts[5]!, "base64url");
  if (salt.length < 8 || key.length < 16 || key.length > 64) return null;
  return { N, r, p, salt, key };
}

/** A fixed, valid hash of a random password: verified against when no account exists (equal timing). */
let dummy: Promise<string> | null = null;
export function dummyPasswordHash(): Promise<string> {
  dummy ??= hashPassword(randomBytes(24).toString("base64url"));
  return dummy;
}

/** Constant-time check of a password against a stored hash. Malformed hashes never match. */
export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  const parsed = parsePasswordHash(stored);
  if (!parsed || typeof password !== "string" || password.length > PASSWORD_MAX_LENGTH * 4) return false;
  const { N, r, p, salt, key } = parsed;
  let candidate: Buffer;
  try {
    candidate = await scrypt(password, salt, key.length, { N, r, p, maxmem: maxmemFor(N, r) });
  } catch {
    return false;
  }
  return candidate.length === key.length && timingSafeEqual(candidate, key);
}

/** True when a stored hash uses weaker parameters than today's. */
export function needsRehash(stored: string | null | undefined): boolean {
  const parsed = parsePasswordHash(stored);
  if (!parsed) return true;
  return parsed.N < SCRYPT_PARAMS.N || parsed.r < SCRYPT_PARAMS.r || parsed.key.length < SCRYPT_KEY_LENGTH;
}

// ── Policy ───────────────────────────────────────────────────────────────────

/**
 * Very common passwords (and the shapes people reach for at 10+ characters).
 * Compared case-insensitively. A small built-in list by design: no breach API.
 */
export const COMMON_PASSWORDS: ReadonlySet<string> = new Set([
  "1234567890", "12345678910", "123456789a", "0987654321", "1111111111", "0000000000", "1q2w3e4r5t",
  "1qaz2wsx3edc", "qwertyuiop", "qwerty1234", "qwerty12345", "qwerty123456", "asdfghjkl1", "zxcvbnm123",
  "password12", "password123", "password1234", "password!", "password01", "passw0rd123", "p@ssw0rd123",
  "p@ssword123", "iloveyou12", "iloveyou123", "letmein123", "welcome123", "welcome1234", "admin12345",
  "administrator", "changeme123", "changeme!!", "football123", "baseball123", "superman123", "batman1234",
  "princess123", "sunshine123", "monkey12345", "dragon12345", "master12345", "shadow12345", "trustno1234",
  "abcdefghij", "abcd123456", "abc1234567", "a123456789", "aa12345678", "qazwsxedcr", "michael123",
  "jessica123", "charlie123", "computer123", "internet123", "starwars123", "whatever123", "freedom123",
  "pokemon123", "liverpool123", "chelsea123", "arsenal123", "mustang123", "secret1234", "hello12345",
  "helloworld", "helloworld1", "loveyou123", "summer2024", "summer2025", "summer2026", "winter2025",
  "winter2026", "spring2026", "autumn2026", "january2026", "october2026", "shapesos123", "marketr123",
  "marketing123", "company123", "password2024", "password2025", "password2026", "1234qwerty", "1234abcd!",
]);

export interface PasswordPolicyContext {
  email?: string | null;
  name?: string | null;
}

/** null when acceptable, else a sentence-case message the UI can show as is. */
export function passwordPolicyError(password: unknown, ctx: PasswordPolicyContext = {}): string | null {
  if (typeof password !== "string" || password.length === 0) return "Enter a password.";
  if ([...password].length < PASSWORD_MIN_LENGTH) return `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
  if (password.length > PASSWORD_MAX_LENGTH) return `Use at most ${PASSWORD_MAX_LENGTH} characters.`;
  const lower = password.toLowerCase();
  if (/^(.)\1+$/.test(password)) return "Don't repeat one character. Pick something harder to guess.";
  if (COMMON_PASSWORDS.has(lower)) return "That password is too common. Pick something harder to guess.";
  const email = (ctx.email ?? "").trim().toLowerCase();
  const local = email.split("@")[0] ?? "";
  if (email && (lower === email || (local.length >= 4 && lower.includes(local) && lower.length - local.length < 6))) {
    return "Don't use your email address in your password.";
  }
  return null;
}
