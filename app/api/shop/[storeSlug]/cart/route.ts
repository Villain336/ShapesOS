// ShapesOS — Phase 10 (store): the public storefront cart.
// GET  /api/shop/[storeSlug]/cart → the buyer's cart, priced from the database
// POST /api/shop/[storeSlug]/cart { action: "add" | "set" | "promo" | "clear",
//        productId?, variantId?, qty?, code? } → updated cart + signed cookie
//
// PUBLIC BY DESIGN (no account is needed to shop): the store must be
// PUBLISHED (resolved through the SELECT-only routing policy; unknown or
// unpublished → 404). The cart is an HMAC-signed cookie bound to this
// store (lib/ops/store/cart.ts) — it only ever names products and
// quantities; every price, stock level and promotion is re-read from the
// database here and again at checkout. Adding a product that isn't listed
// and sellable in this store is refused. Writes nothing to the database.
// Per-store+IP rate limit on top of proxy.ts's IP limit; 4 KiB body cap.

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { CartError, addToCart, emptyCart, setCartPromo, setCartQty } from "@/lib/ops/store/cart";
import { catalogForCart } from "@/lib/ops/store/catalog";
import { itemKey } from "@/lib/ops/store/pricing";
import { cartFromRequest, pricedView, readSmallJson, shopContext, withCart } from "@/lib/ops/store/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ storeSlug: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const { storeSlug } = await params;
  const ctx = await shopContext(req, storeSlug, "cart");
  if (ctx instanceof Response) return ctx;
  const cart = cartFromRequest(req, ctx.store);
  return NextResponse.json(await pricedView(ctx.store, cart), { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest, { params }: Params) {
  const { storeSlug } = await params;
  const ctx = await shopContext(req, storeSlug, "cart");
  if (ctx instanceof Response) return ctx;
  const body = await readSmallJson(req);
  if (body instanceof Response) return body;
  const { store } = ctx;
  let cart = cartFromRequest(req, store);
  try {
    switch (body.action) {
      case "add":
      case "set": {
        const next = body.action === "add" ? addToCart(cart, body.productId, body.variantId, body.qty ?? 1) : setCartQty(cart, body.productId, body.variantId, body.qty);
        if (body.action === "add" || Number(body.qty) > 0) {
          // Only products this store sells may enter the cart.
          const catalog = await withWorkspaceScope(store.workspaceId, (tx) => catalogForCart(tx, store, next));
          const key = itemKey(String(body.productId), (body.variantId as string | null | undefined) ?? null);
          if (!catalog.has(key)) return NextResponse.json({ error: "That product isn't available in this store" }, { status: 404 });
        }
        cart = next;
        break;
      }
      case "promo":
        cart = setCartPromo(cart, body.code);
        break;
      case "clear":
        cart = emptyCart(store.id);
        break;
      default:
        return NextResponse.json({ error: 'action must be "add", "set", "promo" or "clear"' }, { status: 400 });
    }
  } catch (err) {
    if (err instanceof CartError) return NextResponse.json({ error: err.message }, { status: 400 });
    throw err;
  }
  return withCart(await pricedView(store, cart), store, cart);
}
