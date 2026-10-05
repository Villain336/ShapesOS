// ShapesOS — Phase 11 (bizsync): Shopify shop-domain guard + OAuth callback
// HMAC (PURE; no network, no DB).
//
// normalizeShopDomain: the store domain is user input that becomes an OAuth
// and API host, so only "<name>.myshopify.com" is accepted (lower-cased,
// scheme/path stripped). Anything else — custom domains, IPs, other hosts —
// is refused: the connector can never be pointed at an arbitrary server.
//
// verifyShopifyOAuthHmac: Shopify signs the OAuth callback query. Drop the
// `hmac` (and legacy `signature`) params, sort the rest by key, join as
// "k=v&k=v", HMAC-SHA256 with the app's client secret, hex — and compare in
// constant time. Documented at shopify.dev/docs/apps/build/authentication-
// authorization/access-tokens/authorization-code-grant ("Verify the
// installation request"). Webhook bodies use a different scheme (base64 HMAC
// of the raw body) — that one already lives in
// lib/substrate/graph/connectors/hmac.ts (verifyShopifyHmac) and is reused.

import { createHmac, timingSafeEqual } from "node:crypto";

const SHOP_RE = /^[a-z0-9][a-z0-9-]{0,60}\.myshopify\.com$/;

/** "My-Store.myshopify.com", "https://my-store.myshopify.com/admin" → "my-store.myshopify.com"; else null. */
export function normalizeShopDomain(input: string | null | undefined): string | null {
  if (typeof input !== "string") return null;
  let v = input.trim().toLowerCase();
  if (!v) return null;
  v = v.replace(/^https?:\/\//, "").replace(/[/?#].*$/, "");
  if (!v.includes(".")) v = `${v}.myshopify.com`;
  return SHOP_RE.test(v) ? v : null;
}

/** The message Shopify signs: every query param except hmac/signature, sorted, "k=v" joined by "&". */
export function shopifyHmacMessage(query: Record<string, string>): string {
  return Object.keys(query)
    .filter((k) => k !== "hmac" && k !== "signature")
    .sort()
    .map((k) => `${k}=${query[k]}`)
    .join("&");
}

export function verifyShopifyOAuthHmac(query: Record<string, string>, clientSecret: string): boolean {
  const given = query.hmac;
  if (!given || !clientSecret || !/^[0-9a-f]{64}$/i.test(given)) return false;
  const expected = createHmac("sha256", clientSecret).update(shopifyHmacMessage(query), "utf8").digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(given.toLowerCase(), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
