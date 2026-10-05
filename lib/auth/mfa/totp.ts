// ShapesOS — TOTP (RFC 6238) for the second sign-in factor (Phase 4a).
//
// Pure, dependency-free (node:crypto only) so it is unit-testable against the
// RFC 6238 Appendix B vectors. HMAC-SHA1, 30-second steps, 6 digits — what
// every authenticator app (Google Authenticator, 1Password, Authy…) speaks.
//
// Verification accepts the current step ±1 (clock drift) and REJECTS any step
// at or below `lastStep` — the caller stores the last accepted step, so a code
// can never be replayed, not even inside its own 30-second window.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Steps accepted either side of now (RFC 6238 §5.2 recommends at most one). */
export const TOTP_WINDOW = 1;
/** 160-bit secrets (RFC 4226 §4 recommends at least 128). */
export const TOTP_SECRET_BYTES = 20;

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32, no padding (the otpauth:// convention). */
export function base32Encode(buf: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** Decode base32 (case-insensitive; spaces, dashes and padding ignored). */
export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error("Invalid base32 secret");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A fresh random secret, base32-encoded. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(TOTP_SECRET_BYTES));
}

/** The RFC 6238 time step for a unix time in milliseconds. */
export function totpStep(nowMs: number, period = TOTP_PERIOD_SECONDS): number {
  return Math.floor(nowMs / 1000 / period);
}

export type TotpAlgorithm = "sha1" | "sha256" | "sha512";

/**
 * HOTP value (RFC 4226 §5.3) for one counter/step. `key` is the raw secret
 * bytes. Exposed for the RFC test vectors (which also use SHA-256/512 keys).
 */
export function hotp(key: Buffer, counter: number, digits = TOTP_DIGITS, algorithm: TotpAlgorithm = "sha1"): string {
  const msg = Buffer.alloc(8);
  // Counter is a 64-bit big-endian integer; steps fit in 53 bits.
  msg.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  msg.writeUInt32BE(counter >>> 0, 4);
  const mac = createHmac(algorithm, key).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin =
    ((mac[offset] & 0x7f) << 24) |
    ((mac[offset + 1] & 0xff) << 16) |
    ((mac[offset + 2] & 0xff) << 8) |
    (mac[offset + 3] & 0xff);
  return String(bin % 10 ** digits).padStart(digits, "0");
}

/** The TOTP code for a base32 secret at a unix time in milliseconds. */
export function totpCode(secretBase32: string, nowMs: number = Date.now()): string {
  return hotp(base32Decode(secretBase32), totpStep(nowMs));
}

/** Strip spaces/dashes a user may type ("123 456"). */
export function normalizeTotpInput(code: string): string {
  return code.replace(/[\s-]/g, "");
}

export function looksLikeTotp(code: string): boolean {
  return /^\d{6}$/.test(normalizeTotpInput(code));
}

function sameCode(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export type TotpVerifyResult = { ok: true; step: number } | { ok: false; reason: "format" | "mismatch" | "replay" };

/**
 * Verify a 6-digit code against the secret at `nowMs`, ±TOTP_WINDOW steps.
 * Every candidate step is compared (constant-time per comparison, no early
 * exit) so timing doesn't reveal which window matched. A matching step at or
 * below `lastStep` is a replay and is refused.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  opts: { nowMs?: number; lastStep?: number | null; window?: number } = {},
): TotpVerifyResult {
  const input = normalizeTotpInput(code);
  if (!/^\d{6}$/.test(input)) return { ok: false, reason: "format" };
  const key = base32Decode(secretBase32);
  const now = totpStep(opts.nowMs ?? Date.now());
  const window = opts.window ?? TOTP_WINDOW;
  let matched: number | null = null;
  for (let d = -window; d <= window; d++) {
    const step = now + d;
    if (step < 0) continue;
    if (sameCode(hotp(key, step), input) && matched === null) matched = step;
  }
  if (matched === null) return { ok: false, reason: "mismatch" };
  if (opts.lastStep !== null && opts.lastStep !== undefined && matched <= opts.lastStep) {
    return { ok: false, reason: "replay" };
  }
  return { ok: true, step: matched };
}

/** otpauth:// URI for authenticator apps (Key Uri Format). */
export function otpauthUri(opts: { secret: string; accountName: string; issuer?: string }): string {
  const issuer = opts.issuer ?? "ShapesOS";
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(opts.accountName)}`;
  const params = new URLSearchParams({
    secret: opts.secret,
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
