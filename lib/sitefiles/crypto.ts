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

/** Decrypt a value produced by encryptSecret(). */
export function decryptSecret(enc: string): string {
  const [version, ivB64, ctB64, tagB64] = enc.split(":");
  if (version !== "v1" || !ivB64 || !ctB64 || !tagB64) {
    throw new Error("Unrecognized credential format");
  }
  const key = encryptionKey();
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return (
    decipher.update(Buffer.from(ctB64, "base64"), undefined, "utf8") +
    decipher.final("utf8")
  );
}

/**
 * Non-sensitive hint for the UI, e.g. "••••a1b2c3d4". Lets the user confirm
 * which credential is stored without ever exposing it.
 */
export function secretHint(plaintext: string): string {
  const hash = createHash("sha256").update(plaintext, "utf8").digest("hex");
  return `••••${hash.slice(0, 8)}`;
}
