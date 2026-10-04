// ShapesOS — Phase 10 (store): storefront checkout → tenant Stripe Checkout.
//
// createStoreCheckout(store, cart):
//   1. Under the store's tenant scope: the workspace's OWN Stripe key (the
//      FINANCE integration, lib/ops/finance/stripe.ts — never the platform
//      billing key). No key → 409 that says the store owner must connect
//      Stripe; nothing is created.
//   2. Re-price the cart from the database (lib/ops/store/pricing.ts): price,
//      stock and the promotion are re-validated; any problem → 409 with the
//      buyer-facing reason. Client prices never enter.
//   3. Create the OpsOrder (status draft, source "web") from exactly that
//      pricing, and audit it.
//   4. Create the Stripe Checkout Session (outside the DB transaction — a
//      network call never holds a row lock), with metadata workspace_id /
//      order_id / store_id; store the session id on the order. A Stripe
//      failure cancels the draft (audited) and surfaces as 502.
// Payment is only ever recorded by the signed webhook (lib/ops/store/orders.ts).
//
// UNVERIFIED-LIVE: exercised against a stub Stripe client in tests.

import { OPS_ENTITY_MAP } from "../entities";
import { auditOpsEvent, OpsError, type OpsActor } from "../doctype";
import { realStripe, tenantKeys, type StripeFactory } from "../finance/stripe";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import type { Cart } from "./cart";
import { priceCartFor, type PublicStore } from "./catalog";
import { checkoutBlocker } from "./pricing";

/** Checkout Sessions expire after an hour; the expiry webhook cancels the draft. */
export const CHECKOUT_TTL_S = 60 * 60;

export const STOREFRONT_ACTOR = "storefront";

export class StoreNotConnectedError extends OpsError {
  readonly code = "stripe_not_connected";
  constructor() {
    super(409, "This store can't take payments yet. The store owner needs to connect Stripe in Finance settings.");
    this.name = "StoreNotConnectedError";
  }
}

export function orderLabel(orderId: string): string {
  return `SO-${orderId.slice(-6).toUpperCase()}`;
}

interface StripeLineItem {
  quantity: number;
  price_data: { currency: string; unit_amount: number; product_data: { name: string; description?: string } };
}

/**
 * Stripe line items for an order. Itemised when there is no discount
 * (Stripe line amounts can't be negative); with a discount, one line for
 * the whole order so the charged amount equals the order total exactly.
 * Tax is its own line. Σ(qty × unit_amount) === totalCents, always.
 */
export function stripeLineItems(
  order: { id: string; totalCents: number; taxCents: number; discountCents: number; promotionCode?: string | null },
  lines: Array<{ name: string; qty: number; priceCents: number }>,
  currency: string,
): StripeLineItem[] {
  const cur = currency.toLowerCase();
  const item = (name: string, unit: number, qty = 1, description?: string): StripeLineItem => ({
    quantity: qty,
    price_data: { currency: cur, unit_amount: unit, product_data: { name: name.slice(0, 250), ...(description ? { description: description.slice(0, 500) } : {}) } },
  });
  let out: StripeLineItem[];
  if (order.discountCents > 0) {
    const summary = lines.map((l) => `${l.qty} × ${l.name}`).join(", ");
    out = [item(`Order ${orderLabel(order.id)}`, order.totalCents, 1, `${summary}${order.promotionCode ? ` (code ${order.promotionCode})` : ""}${order.taxCents ? ", tax included" : ""}`)];
  } else {
    out = lines.filter((l) => l.priceCents > 0).map((l) => item(l.name, l.priceCents, l.qty));
    if (order.taxCents > 0) out.push(item("Sales tax", order.taxCents));
  }
  const sum = out.reduce((s, l) => s + l.quantity * l.price_data.unit_amount, 0);
  if (sum !== order.totalCents) throw new OpsError(500, `Checkout lines (${sum}c) don't add up to the order total (${order.totalCents}c)`);
  return out;
}

export interface StoreCheckoutResult {
  url: string;
  orderId: string;
  sessionId: string;
}

export async function createStoreCheckout(
  store: PublicStore,
  cart: Cart,
  opts: { baseUrl: string; stripe?: StripeFactory; now?: Date },
): Promise<StoreCheckoutResult> {
  const actor: OpsActor = { workspaceId: store.workspaceId, userId: STOREFRONT_ACTOR };
  const now = opts.now ?? new Date();
  const ORDERS = OPS_ENTITY_MAP["orders"]!;

  const { keys, order, lines } = await withWorkspaceScope(store.workspaceId, async (tx) => {
    const keys = await tenantKeys(tx, store.workspaceId);
    if (!keys.secretKey) throw new StoreNotConnectedError();
    const { priced } = await priceCartFor(tx, store, cart, now);
    const blocker = checkoutBlocker(priced);
    if (blocker) throw new OpsError(409, blocker);
    const lines = priced.lines.map((l) => ({
      name: l.item!.name,
      sku: l.item!.sku,
      qty: l.qty,
      priceCents: l.item!.unitPriceCents,
      productId: l.item!.productId,
      variantId: l.item!.variantId,
      listingId: l.item!.listingId,
    }));
    const promoOk = priced.promo?.ok ? priced.promo : null;
    const order = await tx.opsOrder.create({
      data: {
        workspaceId: store.workspaceId,
        status: "draft",
        source: "web",
        storeId: store.id,
        lineItems: lines,
        subtotalCents: priced.subtotalCents,
        discountCents: priced.discountCents,
        taxCents: priced.taxCents,
        totalCents: priced.totalCents,
        promotionId: promoOk?.promotionId ?? null,
        promotionCode: promoOk?.code ?? null,
      },
    });
    await auditOpsEvent(
      tx,
      ORDERS,
      actor,
      "create",
      order.id,
      `web order ${orderLabel(order.id)} drafted at checkout (${priced.totalCents}c${promoOk ? `, code ${promoOk.code} −${priced.discountCents}c` : ""}) — awaiting payment`,
    );
    return { keys, order, lines };
  });

  const stripe = (opts.stripe ?? realStripe)(keys.secretKey!);
  const shop = `${opts.baseUrl.replace(/\/+$/, "")}/shop/${store.slug}`;
  const metadata = { workspace_id: store.workspaceId, order_id: order.id, store_id: store.id };
  let session: { id: string; url: string | null };
  try {
    session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: stripeLineItems(order, lines, store.currency),
      metadata,
      payment_intent_data: { metadata },
      client_reference_id: order.id,
      success_url: `${shop}/thanks?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${shop}/cart`,
      expires_at: Math.floor(now.getTime() / 1000) + CHECKOUT_TTL_S,
    });
    if (!session.url) throw new Error("Stripe returned no checkout URL");
  } catch (err) {
    await withWorkspaceScope(store.workspaceId, async (tx) => {
      await tx.opsOrder.updateMany({ where: { id: order.id, workspaceId: store.workspaceId, status: "draft" }, data: { status: "cancelled" } });
      await auditOpsEvent(tx, ORDERS, actor, "checkout_failed", order.id, `Stripe checkout could not be created for ${orderLabel(order.id)}: ${(err as Error)?.message ?? "error"}`.slice(0, 500));
    });
    if (err instanceof OpsError) throw err;
    throw new OpsError(502, "Payment provider unavailable. Try again in a moment.");
  }
  await withWorkspaceScope(store.workspaceId, (tx) =>
    tx.opsOrder.updateMany({ where: { id: order.id, workspaceId: store.workspaceId }, data: { stripeSessionId: session.id } }),
  );
  return { url: session.url!, orderId: order.id, sessionId: session.id };
}
