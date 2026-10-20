// ShapesOS — Phase 18.3 (WS=flow): Web Push crypto with node:crypto only.
//
// Two RFCs, no new dependency (the web-push package is NOT used):
//
//   RFC 8292 (VAPID)   the application server identifies itself to the push
//                      service with an ES256 JWT { aud, exp, sub } signed by
//                      its P-256 key: `Authorization: vapid t=<jwt>, k=<pub>`.
//   RFC 8291 (+8188)   the message is encrypted for ONE browser subscription:
//                      ECDH(P-256) with the subscription's p256dh key, HKDF
//                      with its 16-byte auth secret, AES-128-GCM, one record
//                      with the "aes128gcm" content-coding header.
//
// Everything here is pure (keys, salt and the ephemeral key are injectable),
// so lib/push/__tests__/web-push-crypto.test.ts checks it against the
// RFC 8291 Appendix A vector byte for byte and verifies the RFC 8292 example
// JWT. Keys come from env (vapidConfigFromEnv): VAPID_PUBLIC_KEY (65-byte
// uncompressed point, base64url), VAPID_PRIVATE_KEY (32-byte scalar,
// base64url), VAPID_SUBJECT (mailto: or https: contact). Without them Web
// Push is OFF and says so — nothing is faked.

import { createECDH, createCipheriv, createDecipheriv, createHmac, createPrivateKey, createPublicKey, createSign, createVerify, randomBytes, type KeyObject } from "node:crypto";

// ── base64url ───────────────────────────────────────────────────────────────

export function b64url(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf).toString("base64url");
}

export function fromB64url(s: string): Buffer {
  return Buffer.from(s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""), "base64url");
}

// ── VAPID config (RFC 8292) ─────────────────────────────────────────────────

export interface VapidConfig {
  publicKey: string; // base64url, 65 bytes uncompressed (0x04 || X || Y)
  privateKey: string; // base64url, 32 bytes
  subject: string; // mailto:… or https://…
}

export type VapidStatus = { configured: true; config: VapidConfig } | { configured: false; reason: string };

/** Read and validate the VAPID keys; never throws. */
export function vapidConfigFromEnv(env: NodeJS.ProcessEnv = process.env): VapidStatus {
  const publicKey = (env.VAPID_PUBLIC_KEY ?? "").trim();
  const privateKey = (env.VAPID_PRIVATE_KEY ?? "").trim();
  const subject = (env.VAPID_SUBJECT ?? "").trim();
  if (!publicKey || !privateKey) return { configured: false, reason: "VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are not set." };
  if (!/^(mailto:\S+@\S+|https:\/\/\S+)$/.test(subject)) {
    return { configured: false, reason: "VAPID_SUBJECT must be a mailto: address or an https: URL." };
  }
  try {
    const pub = fromB64url(publicKey);
    const priv = fromB64url(privateKey);
    if (pub.length !== 65 || pub[0] !== 0x04) return { configured: false, reason: "VAPID_PUBLIC_KEY is not a 65-byte uncompressed P-256 point." };
    if (priv.length !== 32) return { configured: false, reason: "VAPID_PRIVATE_KEY is not a 32-byte P-256 key." };
    // The pair must match: derive the public point from the scalar.
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(priv);
    if (!ecdh.getPublicKey().equals(pub)) return { configured: false, reason: "VAPID_PUBLIC_KEY does not match VAPID_PRIVATE_KEY." };
  } catch {
    return { configured: false, reason: "The VAPID keys are not valid base64url P-256 keys." };
  }
  return { configured: true, config: { publicKey, privateKey, subject } };
}

/** A fresh VAPID key pair (for docs / ops: `npx tsx -e …generateVapidKeys()`). */
export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { publicKey: b64url(ecdh.getPublicKey()), privateKey: b64url(ecdh.getPrivateKey()) };
}

function privateKeyObject(publicKey: string, privateKey: string): KeyObject {
  const pub = fromB64url(publicKey);
  return createPrivateKey({
    key: { kty: "EC", crv: "P-256", d: b64url(fromB64url(privateKey)), x: b64url(pub.subarray(1, 33)), y: b64url(pub.subarray(33, 65)) },
    format: "jwk",
  });
}

function publicKeyObject(publicKey: string): KeyObject {
  const pub = fromB64url(publicKey);
  if (pub.length !== 65 || pub[0] !== 0x04) throw new Error("not an uncompressed P-256 point");
  return createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64url(pub.subarray(1, 33)), y: b64url(pub.subarray(33, 65)) }, format: "jwk" });
}

/** The push service's origin: the JWT's audience. */
export function audienceFor(endpoint: string): string {
  return new URL(endpoint).origin;
}

/** RFC 8292 §2: an ES256 JWT for one push service origin (default 12 h). */
export function signVapidJwt(opts: { audience: string; subject: string; publicKey: string; privateKey: string; expiresAt?: number; now?: number }): string {
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  // §2: exp MUST be no more than 24 hours from the time of the request.
  const exp = Math.min(opts.expiresAt ?? now + 12 * 3600, now + 24 * 3600);
  const header = b64url(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64url(Buffer.from(JSON.stringify({ aud: opts.audience, exp, sub: opts.subject })));
  const input = `${header}.${claims}`;
  const sig = createSign("SHA256").update(input).sign({ key: privateKeyObject(opts.publicKey, opts.privateKey), dsaEncoding: "ieee-p1363" });
  return `${input}.${b64url(sig)}`;
}

/** Verify an ES256 JWT against a base64url P-256 public key (tests + self-checks). */
export function verifyVapidJwt(jwt: string, publicKey: string): { ok: boolean; claims: Record<string, unknown> | null } {
  const parts = jwt.split(".");
  if (parts.length !== 3) return { ok: false, claims: null };
  try {
    const ok = createVerify("SHA256")
      .update(`${parts[0]}.${parts[1]}`)
      .verify({ key: publicKeyObject(publicKey), dsaEncoding: "ieee-p1363" }, fromB64url(parts[2]!));
    return { ok, claims: JSON.parse(fromB64url(parts[1]!).toString("utf8")) as Record<string, unknown> };
  } catch {
    return { ok: false, claims: null };
  }
}

/** RFC 8292 §3: the Authorization header value. */
export function vapidAuthorization(jwt: string, publicKey: string): string {
  return `vapid t=${jwt}, k=${publicKey}`;
}

// ── aes128gcm encryption (RFC 8291 + RFC 8188) ──────────────────────────────

export const RECORD_SIZE = 4096;
/** One record: rs − 16 (tag) − 1 (delimiter) − 86 (header with a 65-byte key id)… the safe plaintext cap. */
export const MAX_PLAINTEXT = RECORD_SIZE - 16 - 1 - 86;

function hkdfExtract(salt: Buffer, ikm: Buffer): Buffer {
  return createHmac("sha256", salt).update(ikm).digest();
}

function hkdfExpand(prk: Buffer, info: Buffer, length: number): Buffer {
  // length ≤ 32: one block is enough (T(1) = HMAC(PRK, info || 0x01)).
  return createHmac("sha256", prk).update(Buffer.concat([info, Buffer.from([1])])).digest().subarray(0, length);
}

export interface EncryptInput {
  /** The subscription's p256dh key (65 bytes, base64url). */
  p256dh: string;
  /** The subscription's auth secret (16 bytes, base64url). */
  auth: string;
  plaintext: Buffer | string;
  /** Test seams (RFC 8291 Appendix A): the server's ephemeral private key and the salt. */
  asPrivateKey?: Buffer;
  salt?: Buffer;
}

export interface EncryptOutput {
  body: Buffer;
  /** Intermediate values, exposed for the RFC vector test. */
  ecdhSecret: Buffer;
  ikm: Buffer;
  prk: Buffer;
  cek: Buffer;
  nonce: Buffer;
  asPublicKey: Buffer;
}

/** Encrypt one push message for one subscription (a single aes128gcm record). */
export function encryptAes128gcm(input: EncryptInput): EncryptOutput {
  const uaPublic = fromB64url(input.p256dh);
  const authSecret = fromB64url(input.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) throw new Error("p256dh must be a 65-byte uncompressed P-256 point");
  if (authSecret.length !== 16) throw new Error("auth must be 16 bytes");
  const plaintext = Buffer.isBuffer(input.plaintext) ? input.plaintext : Buffer.from(input.plaintext, "utf8");
  if (plaintext.length > MAX_PLAINTEXT) throw new Error(`push payload too large (${plaintext.length} > ${MAX_PLAINTEXT} bytes)`);

  const ecdh = createECDH("prime256v1");
  if (input.asPrivateKey) ecdh.setPrivateKey(input.asPrivateKey);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic);

  // RFC 8291 §3.3–3.4
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0", "latin1"), uaPublic, asPublic]);
  const ikm = hkdfExpand(hkdfExtract(authSecret, ecdhSecret), keyInfo, 32);
  const salt = input.salt ?? randomBytes(16);
  if (salt.length !== 16) throw new Error("salt must be 16 bytes");
  const prk = hkdfExtract(salt, ikm);
  const cek = hkdfExpand(prk, Buffer.from("Content-Encoding: aes128gcm\0", "latin1"), 16);
  const nonce = hkdfExpand(prk, Buffer.from("Content-Encoding: nonce\0", "latin1"), 12);

  // RFC 8188 §2: one (last) record = plaintext || 0x02 delimiter, no padding.
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const ct = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  return { body: Buffer.concat([header, asPublic, ct]), ecdhSecret, ikm, prk, cek, nonce, asPublicKey: asPublic };
}

/** The browser side (tests): decrypt with the subscription's private key. */
export function decryptAes128gcm(body: Buffer, uaPrivateKey: Buffer, auth: string): Buffer {
  const salt = body.subarray(0, 16);
  const idlen = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(uaPrivateKey);
  const uaPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0", "latin1"), uaPublic, asPublic]);
  const ikm = hkdfExpand(hkdfExtract(fromB64url(auth), ecdhSecret), keyInfo, 32);
  const prk = hkdfExtract(salt, ikm);
  const cek = hkdfExpand(prk, Buffer.from("Content-Encoding: aes128gcm\0", "latin1"), 16);
  const nonce = hkdfExpand(prk, Buffer.from("Content-Encoding: nonce\0", "latin1"), 12);
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(ct.subarray(ct.length - 16));
  const padded = Buffer.concat([decipher.update(ct.subarray(0, ct.length - 16)), decipher.final()]);
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end--;
  if (padded[end] !== 2) throw new Error("bad record delimiter");
  return padded.subarray(0, end);
}
