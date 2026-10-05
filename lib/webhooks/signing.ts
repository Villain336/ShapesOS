// ShapesOS — outbound webhook signatures (Phase 4a). Stripe-style.
//
// Every delivery carries
//   ShapesOS-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256>
// where the HMAC key is the endpoint's whole secret string ("whsec_…", UTF-8)
// and the signed message is `${t}.${rawBody}`. Receivers recompute it over
// the raw body, compare in constant time, and reject timestamps outside the
// replay window (default 5 minutes) — verifyWebhookSignature does exactly
// that and is what our tests use as the reference receiver.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "ShapesOS-Signature";
export const EVENT_ID_HEADER = "ShapesOS-Event-Id";
export const EVENT_TYPE_HEADER = "ShapesOS-Event-Type";
export const DELIVERY_ID_HEADER = "ShapesOS-Delivery-Id";
export const WEBHOOK_USER_AGENT = "ShapesOS-Webhooks/1.0";

/** Replay window: signatures older (or newer) than this are rejected. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

export const SECRET_PREFIX = "whsec_";

/** New signing secret (raw; shown to the admin once, stored encrypted). */
export function mintWebhookSecret(): string {
  return `${SECRET_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/** Non-sensitive hint for the UI. */
export function secretHint(secret: string): string {
  return `${secret.slice(0, SECRET_PREFIX.length + 4)}…${secret.slice(-4)}`;
}

export function computeSignature(secret: string, timestamp: number, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`, "utf8").digest("hex");
}

/** The ShapesOS-Signature header value for a body signed at `timestamp` (unix seconds). */
export function signatureHeader(secret: string, body: string, timestamp: number): string {
  return `t=${timestamp},v1=${computeSignature(secret, timestamp, body)}`;
}

export function parseSignatureHeader(header: string | null | undefined): { t: number; v1: string[] } | null {
  if (!header) return null;
  let t: number | null = null;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const [k, ...rest] = part.trim().split("=");
    const v = rest.join("=");
    if (k === "t" && /^\d{1,12}$/.test(v)) t = Number(v);
    else if (k === "v1" && /^[0-9a-f]{64}$/.test(v)) v1.push(v);
  }
  return t === null || v1.length === 0 ? null : { t, v1 };
}

export type VerifyResult = { ok: true; timestamp: number } | { ok: false; reason: "malformed" | "expired" | "mismatch" };

/**
 * Reference receiver check: constant-time HMAC compare + replay window.
 * Accepts any of several v1 signatures (secret rotation overlap).
 */
export function verifyWebhookSignature(
  secret: string,
  rawBody: string,
  header: string | null | undefined,
  opts: { toleranceSeconds?: number; now?: number } = {},
): VerifyResult {
  const parsed = parseSignatureHeader(header);
  if (!parsed) return { ok: false, reason: "malformed" };
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  const tolerance = opts.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (Math.abs(now - parsed.t) > tolerance) return { ok: false, reason: "expired" };
  const expected = Buffer.from(computeSignature(secret, parsed.t, rawBody), "hex");
  const match = parsed.v1.some((sig) => {
    const got = Buffer.from(sig, "hex");
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
  return match ? { ok: true, timestamp: parsed.t } : { ok: false, reason: "mismatch" };
}
