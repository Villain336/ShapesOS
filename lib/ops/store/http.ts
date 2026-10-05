// ShapesOS — Phase 10 (store): plumbing shared by the two public storefront
// routes (app/api/shop/[storeSlug]/{cart,checkout}). Both are PUBLIC BY
// DESIGN — see the route headers and scripts/verify-m11-security.mjs.

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { clientIpFromHeaders } from "@/lib/api/client-ip";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { CartConfigError, cartCookieName, cartCookieOptions, readCart, signCart, type Cart } from "./cart";
import { priceCartFor, resolvePublishedStore, type PublicStore } from "./catalog";
import { storeHit, STORE_LIMITS } from "./limits";
import { cartView, type CartView } from "./view";

export const SHOP_BODY_LIMIT = 4096;

export function notFound(): Response {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

export function tooMany(retryAfterMs: number): Response {
  return NextResponse.json(
    { error: "Too many requests. Try again shortly." },
    { status: 429, headers: { "Retry-After": String(Math.max(1, Math.ceil(retryAfterMs / 1000))) } },
  );
}

/** Resolve the published store + rate-limit this store/IP, or a ready Response. */
export async function shopContext(
  req: NextRequest,
  storeSlug: string,
  kind: keyof typeof STORE_LIMITS,
): Promise<{ store: PublicStore; ip: string | null; attempt: number } | Response> {
  const store = await resolvePublishedStore(storeSlug);
  if (!store) return notFound();
  const ip = clientIpFromHeaders(req.headers);
  const hit = await storeHit(kind, store.id, ip);
  if (!hit.allowed) return tooMany(hit.retryAfterMs);
  return { store, ip, attempt: hit.count };
}

export function cartFromRequest(req: NextRequest, store: PublicStore): Cart {
  return readCart(req.cookies.get(cartCookieName(store.id))?.value, store.id);
}

export async function readSmallJson(req: NextRequest): Promise<Record<string, unknown> | Response> {
  const raw = await req.text();
  if (raw.length > SHOP_BODY_LIMIT) return NextResponse.json({ error: "Request too large" }, { status: 413 });
  try {
    const v = raw.trim() ? (JSON.parse(raw) as unknown) : {};
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
    return v as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
}

export async function pricedView(store: PublicStore, cart: Cart): Promise<CartView> {
  const { priced } = await withWorkspaceScope(store.workspaceId, (tx) => priceCartFor(tx, store, cart));
  return cartView(cart, priced, store.currency);
}

/** JSON response that also (re)writes the signed cart cookie. */
export function withCart(body: unknown, store: PublicStore, cart: Cart, status = 200): Response {
  const res = NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
  try {
    if (cart.lines.length === 0 && !cart.promoCode) res.cookies.delete(cartCookieName(store.id));
    else res.cookies.set(cartCookieName(store.id), signCart(cart), cartCookieOptions());
  } catch (err) {
    if (err instanceof CartConfigError) return NextResponse.json({ error: err.message }, { status: 503 });
    throw err;
  }
  return res;
}
