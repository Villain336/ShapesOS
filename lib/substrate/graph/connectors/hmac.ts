// Marketr — Phase 8 G1: webhook signature verification + replay protection.
//
// Safety invariant §9.8: every Tier-W endpoint verifies HMAC/platform
// signatures and rejects unsigned payloads. Replay protection on all ingest
// endpoints: (timestamp within window) + (nonce seen-cache). Secrets are
// passed in, never logged — verification failures log only the reason and
// the payload hash, never the secret or the raw body.

import { createHmac, timingSafeEqual, createHash } from "node:crypto";

export interface VerifyResult {
  ok: boolean;
  reason?: string;
}

function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** HubSpot v3: base64(HMAC-SHA256(secret, method + uri + body + timestamp)). */
export function verifyHubSpotSignature(
  secret: string,
  method: string,
  uri: string,
  rawBody: string,
  timestampHeader: string | null,
  signatureHeader: string | null,
): VerifyResult {
  if (!signatureHeader) return { ok: false, reason: "missing X-HubSpot-Signature-v3" };
  if (!timestampHeader) return { ok: false, reason: "missing X-HubSpot-Request-Timestamp" };
  const ts = Number(timestampHeader);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > 5 * 60_000) {
    return { ok: false, reason: "timestamp outside ±5min window" };
  }
  const expected = createHmac("sha256", secret)
    .update(`${method}${uri}${rawBody}${timestampHeader}`)
    .digest("base64");
  return safeEqualHex(expected, signatureHeader)
    ? { ok: true }
    : { ok: false, reason: "signature mismatch" };
}

/** Shopify: base64(HMAC-SHA256(secret, rawBody)). */
export function verifyShopifyHmac(
  secret: string,
  rawBody: string,
  hmacHeader: string | null,
): VerifyResult {
  if (!hmacHeader) return { ok: false, reason: "missing X-Shopify-Hmac-Sha256" };
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
  return safeEqualHex(expected, hmacHeader) ? { ok: true } : { ok: false, reason: "signature mismatch" };
}

/** Meta: "sha256=" + hex(HMAC-SHA256(appSecret, rawBody)). */
export function verifyMetaSignature(
  appSecret: string,
  rawBody: string,
  signatureHeader: string | null,
): VerifyResult {
  if (!signatureHeader) return { ok: false, reason: "missing X-Hub-Signature-256" };
  const expected =
    "sha256=" + createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
  return safeEqualHex(expected, signatureHeader)
    ? { ok: true }
    : { ok: false, reason: "signature mismatch" };
}

/** WooCommerce: base64(HMAC-SHA256(webhook secret, rawBody)). */
export function verifyWooCommerceSignature(
  secret: string,
  rawBody: string,
  signatureHeader: string | null,
): VerifyResult {
  if (!signatureHeader) return { ok: false, reason: "missing X-WC-Webhook-Signature" };
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
  return safeEqualHex(expected, signatureHeader) ? { ok: true } : { ok: false, reason: "signature mismatch" };
}

// ---------------------------------------------------------------------------
// Replay protection: timestamp window + seen-nonce LRU. v1 is an in-process
// cache (single-instance assumption, documented); a Redis/DB-backed store
// slots in behind the same interface for multi-instance deploys.
// ---------------------------------------------------------------------------

export interface ReplayStore {
  seen(nonce: string): Promise<boolean>;
  remember(nonce: string, ttlSec: number): Promise<void>;
}

const seenNonces = new Map<string, number>(); // nonce -> expiry epoch ms

export const memoryReplayStore: ReplayStore = {
  async seen(nonce: string) {
    const exp = seenNonces.get(nonce);
    if (exp === undefined) return false;
    if (exp < Date.now()) {
      seenNonces.delete(nonce);
      return false;
    }
    return true;
  },
  async remember(nonce: string, ttlSec: number) {
    seenNonces.set(nonce, Date.now() + ttlSec * 1000);
    if (seenNonces.size > 50_000) {
      const oldest = [...seenNonces.entries()].sort((a, b) => a[1] - b[1])[0];
      if (oldest) seenNonces.delete(oldest[0]);
    }
  },
};

/**
 * Reject replays: the (platform, delivery-id/timestamp) tuple must be fresh
 * and unseen. deliveryId falls back to a hash of the raw body — identical
 * bodies redelivered within the window are treated as replays (HubSpot
 * retries the same payload; dedupe is idempotent-safe via contentHash).
 */
export async function checkReplay(
  platform: string,
  rawBody: string,
  deliveryId: string | null,
  timestampMs: number | null,
  store: ReplayStore = memoryReplayStore,
  windowSec = 600,
): Promise<VerifyResult> {
  const now = Date.now();
  if (timestampMs !== null && Math.abs(now - timestampMs) > windowSec * 1000) {
    return { ok: false, reason: "delivery timestamp outside replay window" };
  }
  const nonce =
    deliveryId ??
    `${platform}:${createHash("sha256").update(rawBody).digest("hex").slice(0, 32)}`;
  if (await store.seen(nonce)) {
    return { ok: false, reason: "replay: delivery already processed" };
  }
  await store.remember(nonce, windowSec);
  return { ok: true };
}

/** Non-secret fingerprint for logs: sha256(rawBody) truncated. */
export function payloadFingerprint(rawBody: string): string {
  return createHash("sha256").update(rawBody).digest("hex").slice(0, 16);
}
