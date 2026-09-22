// Marketr — at-rest encryption for site connection credentials.
// AES-256-GCM with a key from MARKETR_CREDENTIALS_KEY (64 hex chars or
// 44 base64 chars — generate with `openssl rand -hex 32`).
//
// Production note: for hosted SaaS, replace this env-key scheme with a
// KMS/vault (AWS KMS, HashiCorp Vault) with per-workspace data keys and
// key rotation. The env key is acceptable for self-hosted single-node
// deployments. Secrets are NEVER sent to the client — decryption happens
// server-side only, inside getSiteFileProvider().

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "crypto";

const ALGO = "aes-256-gcm";

function encryptionKey(): Buffer {
  const raw = (process.env.MARKETR_CREDENTIALS_KEY ?? "").trim();
  if (!raw) {
    throw new Error(
      "MARKETR_CREDENTIALS_KEY is not set. Generate one with `openssl rand -hex 32` and add it to .env.",
    );
  }
  // Accept 64 hex chars (32 bytes) or base64.
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, "hex");
  const buf = Buffer.from(raw, "base64");
  if (buf.length === 32) return buf;
  throw new Error(
    "MARKETR_CREDENTIALS_KEY must be 32 bytes as hex (64 chars) or base64.",
  );
}

/**
 * Strict canonical-base64 check.
 *
 * Node's base64 decoder is lenient — bytes outside the base64 alphabet are
 * silently dropped, and non-zero padding bits are ignored. On an
 * authenticated envelope that leniency is a tamper-DETECTION hole: a
 * corruption that lands in the tag's trailing padding (e.g. "…==" →
 * "…<0xa6><0x9a>") would otherwise decode to the original 16-byte tag and
 * GCM would still verify, so the tamper would go undetected. Forging a
 * *different* payload was never possible (the ciphertext is authenticated),
 * but we want tamper rejection to be total.
 *
 * This rejects non-canonical input BEFORE decoding: non-alphabet characters,
 * any whitespace, wrong/missing padding, and bad length (mod 4). The
 * canonical re-encode round-trip additionally rejects non-zero padding bits
 * and any other non-canonical encoding the lenient decoder would silently
 * accept.
 *
 * Safe for existing data: every envelope is produced by encryptSecret()
 * via Buffer.toString("base64"), which always emits canonical base64, so
 * strict validation never rejects legitimately stored envelopes. An empty
 * ciphertext part is permitted (it round-trips an empty plaintext).
 */
const B64_STD_RE = /^[A-Za-z0-9+/]*={0,2}$/;

function assertCanonicalBase64(part: string): Buffer {
  if (part.length % 4 !== 0 || !B64_STD_RE.test(part)) {
    throw new Error("Unrecognized credential format");
  }
  const buf = Buffer.from(part, "base64");
  if (buf.toString("base64") !== part) {
    throw new Error("Unrecognized credential format");
  }
  return buf;
}

/** Encrypt a plaintext secret. Returns "v1:iv:ciphertext:tag" (base64 parts). */
export function encryptSecret(plaintext: string): string {
  const key = encryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    "v1",
    iv.toString("base64"),
    ciphertext.toString("base64"),
    tag.toString("base64"),
  ].join(":");
}

/**
 * Decrypt a value produced by encryptSecret().
 *
 * The envelope structure and every base64 part are strictly validated
 * BEFORE any decoding or decryption: exactly 4 colon-separated parts with a
 * "v1" version, canonical base64 parts, a 12-byte IV, and a 16-byte auth
 * tag. (An empty ciphertext part is allowed — it round-trips an empty
 * plaintext.) Tampered or corrupted envelopes are rejected here — never
 * silently repaired by the lenient decoder.
 */
export function decryptSecret(enc: string): string {
  const parts = enc.split(":");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("Unrecognized credential format");
  }
  const [, ivB64, ctB64, tagB64] = parts;
  const iv = assertCanonicalBase64(ivB64);
  const ct = assertCanonicalBase64(ctB64);
  const tag = assertCanonicalBase64(tagB64);
  if (iv.length !== 12) {
    throw new Error("Unrecognized credential format");
  }
  if (tag.length !== 16) {
    throw new Error("Unrecognized credential format");
  }
  const key = encryptionKey();
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ct, undefined, "utf8") + decipher.final("utf8");
}

/**
 * Non-sensitive hint for the UI, e.g. "••••a1b2c3d4". Lets the user confirm
 * which credential is stored without ever exposing it.
 */
export function secretHint(plaintext: string): string {
  const hash = createHash("sha256").update(plaintext, "utf8").digest("hex");
  return `••••${hash.slice(0, 8)}`;
}
