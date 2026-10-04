// ShapesOS — Phase 10 (store): server-side cart pricing. PURE (no I/O).
//
// The single place a storefront total is computed. Every input that decides
// money comes from the database snapshot the caller loaded (catalog items,
// stock, the promotion row, the store's tax rate) — the cart contributes only
// WHICH items and HOW MANY. Used for the cart page (show issues, keep going)
// and for checkout (any issue → refuse; the order is created from exactly
// this result).
//
//   subtotal  Σ qty × unit price (variant price, else product price)
//   discount  evaluatePromotion (lib/ops/promotions.ts — the one evaluator):
//             active, window, usage limit, minimum subtotal, SKU scope
//   tax       store tax rate (basis points) on (subtotal − discount),
//             rounded half-up once
//   total     subtotal − discount + tax
//
// Integer cents throughout; nothing here trusts a client number.

import { evaluatePromotion, parsePromotionRules, type PromotionLike } from "../promotions";
import { divRoundHalfUp } from "../finance/money";
import { OPS_MAX_CENTS } from "../entities";
import type { CartLine } from "./cart";

/** One sellable thing as the database says it is right now. */
export interface CatalogItem {
  productId: string;
  /** Resolved variant id (the default variant when the product has none). */
  variantId: string;
  /** Null when the item is the product's default variant. */
  publicVariantId: string | null;
  listingId: string;
  listingSlug: string;
  name: string;
  sku: string;
  /** SKU of the product itself (promotion productSkus match on it too). */
  productSku: string;
  unitPriceCents: number;
  trackInventory: boolean;
  /** On-hand for tracked items; null = not stock-tracked (always available). */
  available: number | null;
  /** False when the listing is unlisted, or the product/variant inactive. */
  sellable: boolean;
}

export type LineIssue =
  | { kind: "unavailable" }
  | { kind: "insufficient_stock"; available: number };

export interface PricedLine {
  productId: string;
  variantId: string | null;
  qty: number;
  item: CatalogItem | null;
  lineTotalCents: number;
  issue: LineIssue | null;
}

export interface PromoResult {
  code: string;
  ok: boolean;
  reason?: string;
  promotionId?: string;
  discountCents: number;
}

export interface PricedCart {
  lines: PricedLine[];
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
  promo: PromoResult | null;
  /** True when every line is sellable in the asked quantity (and the cart is not empty). */
  checkoutReady: boolean;
}

export type PromotionRow = PromotionLike & { id: string };

export const itemKey = (productId: string, variantId: string | null) => `${productId}|${variantId ?? ""}`;

export function priceCart(input: {
  lines: CartLine[];
  /** Keyed by itemKey(productId, cartVariantId) — the cart's own variant reference. */
  catalog: ReadonlyMap<string, CatalogItem>;
  promoCode: string | null;
  /** The promotion row matching promoCode (case-insensitive), or null. */
  promotion: PromotionRow | null;
  taxRateBps: number;
  now?: Date;
}): PricedCart {
  const lines: PricedLine[] = input.lines.map((l) => {
    const item = input.catalog.get(itemKey(l.productId, l.variantId)) ?? null;
    let issue: LineIssue | null = null;
    if (!item || !item.sellable) issue = { kind: "unavailable" };
    else if (item.available !== null && item.available < l.qty) issue = { kind: "insufficient_stock", available: Math.max(0, item.available) };
    const lineTotalCents = item && issue?.kind !== "unavailable" ? l.qty * item.unitPriceCents : 0;
    return { productId: l.productId, variantId: l.variantId, qty: l.qty, item, lineTotalCents, issue };
  });
  const billable = lines.filter((l) => l.item && l.issue?.kind !== "unavailable");
  const subtotalCents = billable.reduce((s, l) => s + l.lineTotalCents, 0);

  let promo: PromoResult | null = null;
  let discountCents = 0;
  if (input.promoCode) {
    if (!input.promotion) {
      promo = { code: input.promoCode, ok: false, reason: "That code isn't valid", discountCents: 0 };
    } else {
      // A line matches a SKU-scoped promotion by its variant SKU or, failing
      // that, its product SKU.
      const scope = parsePromotionRules(input.promotion.rules).productSkus;
      const promoLines = billable.map((l) => ({
        sku: scope && !scope.includes(l.item!.sku) ? l.item!.productSku : l.item!.sku,
        qty: l.qty,
        priceCents: l.item!.unitPriceCents,
      }));
      const v = evaluatePromotion(input.promotion, promoLines, input.now);
      if (v.ok) {
        discountCents = Math.min(v.discountCents, subtotalCents);
        promo = { code: input.promoCode, ok: true, promotionId: input.promotion.id, discountCents };
      } else {
        promo = { code: input.promoCode, ok: false, reason: v.reason, discountCents: 0 };
      }
    }
  }

  const net = subtotalCents - discountCents;
  const bps = Number.isInteger(input.taxRateBps) && input.taxRateBps > 0 ? input.taxRateBps : 0;
  const taxCents = bps && net > 0 ? divRoundHalfUp(net * bps, 10_000) : 0;
  const totalCents = net + taxCents;
  const checkoutReady = lines.length > 0 && lines.every((l) => l.issue === null) && totalCents > 0 && totalCents <= OPS_MAX_CENTS;
  return { lines, subtotalCents, discountCents, taxCents, totalCents, promo, checkoutReady };
}

/** Why checkout is refused, in the buyer's words (null = ready). */
export function checkoutBlocker(p: PricedCart): string | null {
  if (p.lines.length === 0) return "Your cart is empty.";
  for (const l of p.lines) {
    const name = l.item?.name ?? "An item";
    if (l.issue?.kind === "unavailable") return `${name} is no longer available. Remove it to continue.`;
    if (l.issue?.kind === "insufficient_stock") {
      return l.issue.available > 0
        ? `Only ${l.issue.available} of ${name} left. Lower the quantity to continue.`
        : `${name} is out of stock. Remove it to continue.`;
    }
  }
  if (p.totalCents <= 0) return "There is nothing to pay for.";
  if (p.totalCents > OPS_MAX_CENTS) return "This order is too large to check out online.";
  return null;
}
