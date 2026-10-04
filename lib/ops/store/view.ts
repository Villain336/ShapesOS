// ShapesOS — Phase 10 (store): the buyer-facing cart view (shared by the
// cart page and the public cart API) and money formatting. Only data the
// storefront already shows publicly goes in here — never stock ledger
// details, costs or another buyer's anything.

import { checkoutBlocker, type PricedCart } from "./pricing";
import { cartItemCount, type Cart } from "./cart";

export interface CartViewLine {
  productId: string;
  variantId: string | null;
  listingId: string | null;
  listingSlug: string | null;
  name: string;
  sku: string | null;
  qty: number;
  unitPriceCents: number | null;
  lineTotalCents: number;
  issue: string | null;
}

export interface CartView {
  currency: string;
  count: number;
  lines: CartViewLine[];
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
  promo: { code: string; ok: boolean; reason: string | null; discountCents: number } | null;
  checkoutReady: boolean;
  blocker: string | null;
}

export function cartView(cart: Cart, priced: PricedCart, currency: string): CartView {
  return {
    currency,
    count: cartItemCount(cart),
    lines: priced.lines.map((l) => ({
      productId: l.productId,
      variantId: l.variantId,
      listingId: l.item?.listingId ?? null,
      listingSlug: l.item?.listingSlug ?? null,
      name: l.item?.name ?? "Unavailable item",
      sku: l.item?.sku ?? null,
      qty: l.qty,
      unitPriceCents: l.item?.unitPriceCents ?? null,
      lineTotalCents: l.lineTotalCents,
      issue:
        l.issue?.kind === "unavailable"
          ? "No longer available"
          : l.issue?.kind === "insufficient_stock"
            ? l.issue.available > 0
              ? `Only ${l.issue.available} left`
              : "Out of stock"
            : null,
    })),
    subtotalCents: priced.subtotalCents,
    discountCents: priced.discountCents,
    taxCents: priced.taxCents,
    totalCents: priced.totalCents,
    promo: priced.promo ? { code: priced.promo.code, ok: priced.promo.ok, reason: priced.promo.reason ?? null, discountCents: priced.promo.discountCents } : null,
    checkoutReady: priced.checkoutReady,
    blocker: cart.lines.length === 0 ? null : checkoutBlocker(priced),
  };
}

export function fmtPrice(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

/** schema.org Offer availability for a listing. */
export function availabilityUrl(available: number | null): string {
  return available === null || available > 0 ? "https://schema.org/InStock" : "https://schema.org/OutOfStock";
}

/** Same label the Orders view shows (components/ops/shared.tsx shortId). */
export function orderLabel(orderId: string): string {
  return `SO-${orderId.length > 12 ? orderId.slice(-8).toUpperCase() : orderId.toUpperCase()}`;
}
