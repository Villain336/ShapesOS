// Marketr — at-rest encryption for site connection credentials.
// AES-256-GCM with a key from MARKETR_CREDENTIALS_KEY (64 hex chars or
// 44 base64 chars — generate with `openssl rand -hex 32`).
//
// Key rotation (Phase 1): envelopes are "v2:<kid>:iv:ciphertext:tag", where
// kid is a non-secret fingerprint of the key that sealed it (also bound as
// GCM additional data). To rotate: move the old key to
// MARKETR_CREDENTIALS_KEY_PREVIOUS (comma-separated, several allowed), set a
// new MARKETR_CREDENTIALS_KEY, and re-encrypt at leisure
// (needsReencryption / reencryptSecret). New envelopes always use the
// current key; old v2 envelopes decrypt by kid, and legacy "v1" envelopes
// (no kid) are tried against the current then the previous keys.
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

function parseKey(raw: string, name: string): Buffer {
  // Accept 64 hex chars (32 bytes) or base64.
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, "hex");
  const buf = Buffer.from(raw, "base64");
  if (buf.length === 32) return buf;
  throw new Error(`${name} must be 32 bytes as hex (64 chars) or base64.`);
}

function encryptionKey(): Buffer {
  const raw = (process.env.MARKETR_CREDENTIALS_KEY ?? "").trim();
  if (!raw) {
    throw new Error(
      "MARKETR_CREDENTIALS_KEY is not set. Generate one with `openssl rand -hex 32` and add it to .env.",
    );
  }
  return parseKey(raw, "MARKETR_CREDENTIALS_KEY");
}

/** Retired keys that may still decrypt (MARKETR_CREDENTIALS_KEY_PREVIOUS). */
function previousKeys(): Buffer[] {
  return (process.env.MARKETR_CREDENTIALS_KEY_PREVIOUS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((raw) => parseKey(raw, "MARKETR_CREDENTIALS_KEY_PREVIOUS"));
}

/** Non-secret key fingerprint stored in the envelope (8 hex chars). */
export function credentialKeyId(key: Buffer): string {
  return createHash("sha256").update("marketr-credentials-kid:").update(key).digest("hex").slice(0, 8);
}

/** Key id of the current MARKETR_CREDENTIALS_KEY. */
export function currentCredentialKeyId(): string {
  return credentialKeyId(encryptionKey());
}

const KID_RE = /^[0-9a-f]{8}$/;

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

/** Encrypt a plaintext secret with the CURRENT key.
 *  Returns "v2:kid:iv:ciphertext:tag" (kid hex, other parts base64). */
export function encryptSecret(plaintext: string): string {
  const key = encryptionKey();
  const kid = credentialKeyId(key);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  cipher.setAAD(Buffer.from(`v2:${kid}`, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    "v2",
    kid,
    iv.toString("base64"),
    ciphertext.toString("base64"),
    tag.toString("base64"),
  ].join(":");
}

function gcmOpen(key: Buffer, iv: Buffer, ct: Buffer, tag: Buffer, aad: Buffer | null): string {
  const decipher = createDecipheriv(ALGO, key, iv);
  if (aad) decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return decipher.update(ct, undefined, "utf8") + decipher.final("utf8");
}

function openParts(ivB64: string, ctB64: string, tagB64: string) {
  const iv = assertCanonicalBase64(ivB64);
  const ct = assertCanonicalBase64(ctB64);
  const tag = assertCanonicalBase64(tagB64);
  if (iv.length !== 12 || tag.length !== 16) {
    throw new Error("Unrecognized credential format");
  }
  return { iv, ct, tag };
}

/**
 * Decrypt a value produced by encryptSecret() — current or retired key.
 *
 * The envelope structure and every base64 part are strictly validated
 * BEFORE any decoding or decryption: "v2:<8-hex kid>:iv:ct:tag" (or the
 * legacy 4-part "v1:iv:ct:tag"), canonical base64 parts, a 12-byte IV, and a
 * 16-byte auth tag. (An empty ciphertext part is allowed — it round-trips
 * an empty plaintext.) Tampered or corrupted envelopes are rejected here —
 * never silently repaired by the lenient decoder.
 *
 * v2 picks the key by kid (current or MARKETR_CREDENTIALS_KEY_PREVIOUS) and
 * authenticates the kid as GCM additional data. v1 has no kid: the current
 * key is tried first, then each previous key.
 */
export function decryptSecret(enc: string): string {
  const parts = enc.split(":");
  if (parts.length === 5 && parts[0] === "v2" && KID_RE.test(parts[1])) {
    const [, kid, ivB64, ctB64, tagB64] = parts;
    const { iv, ct, tag } = openParts(ivB64, ctB64, tagB64);
    const key = [encryptionKey(), ...previousKeys()].find((k) => credentialKeyId(k) === kid);
    if (!key) {
      throw new Error(
        `Credential was encrypted with key ${kid}, which is neither MARKETR_CREDENTIALS_KEY nor in MARKETR_CREDENTIALS_KEY_PREVIOUS.`,
      );
    }
    return gcmOpen(key, iv, ct, tag, Buffer.from(`v2:${kid}`, "utf8"));
  }
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("Unrecognized credential format");
  }
  const [, ivB64, ctB64, tagB64] = parts;
  const { iv, ct, tag } = openParts(ivB64, ctB64, tagB64);
  const keys = [encryptionKey(), ...previousKeys()];
  let lastErr: unknown = null;
  for (const key of keys) {
    try {
      return gcmOpen(key, iv, ct, tag, null);
    } catch (e) {
      lastErr = e; // wrong key → GCM auth failure; try the next one
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("Unable to decrypt credential");
}

/** True when an envelope is legacy (v1) or sealed by a retired key. */
export function needsReencryption(enc: string): boolean {
  const parts = enc.split(":");
  if (parts[0] === "v2" && parts.length === 5) return parts[1] !== currentCredentialKeyId();
  return true;
}

/** Re-seal an envelope with the current key (rotation helper). */
export function reencryptSecret(enc: string): string {
  return needsReencryption(enc) ? encryptSecret(decryptSecret(enc)) : enc;
}

/**
 * Non-sensitive hint for the UI, e.g. "••••a1b2c3d4". Lets the user confirm
 * which credential is stored without ever exposing it.
 */
export function secretHint(plaintext: string): string {
  const hash = createHash("sha256").update(plaintext, "utf8").digest("hex");
  return `••••${hash.slice(0, 8)}`;
}
