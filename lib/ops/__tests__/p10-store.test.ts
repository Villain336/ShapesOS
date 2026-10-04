// ShapesOS — Phase 10 (store): pure storefront rules.
//   - signed cart cookie: round trip, tamper / other store / other secret /
//     no secret → empty cart; malformed bodies; merge + caps
//   - server-side pricing: database prices only, unavailable / short stock,
//     untracked items, tax rounding, checkout blockers
//   - promotions: window, usage limit, minimum, SKU scope (variant or product)
//   - Stripe line items always add up to the order total
//   - the web-order posting rule balances; slugify
// Run: npx tsx --test lib/ops/__tests__/p10-store.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CART_MAX_QTY,
  CartError,
  addToCart,
  cartCookieName,
  emptyCart,
  readCart,
  setCartPromo,
  setCartQty,
  signCart,
  type Cart,
} from "../store/cart";
import { checkoutBlocker, itemKey, priceCart, type CatalogItem, type PromotionRow } from "../store/pricing";
import { evaluatePromotion } from "../promotions";
import { stripeLineItems } from "../store/checkout";
import { slugify } from "../store/admin";
import { assertBalanced, webOrderSaleLines } from "../accounting/rules";
import { cartView } from "../store/view";

const ENV = { AUTH_SECRET: "test-secret-for-store-carts-0123456789" };

describe("signed cart cookie", () => {
  const cart: Cart = { storeId: "st_a", lines: [{ productId: "p1", variantId: null, qty: 2 }, { productId: "p2", variantId: "v9", qty: 1 }], promoCode: "SAVE10" };

  it("round-trips for the same store", () => {
    const v = signCart(cart, ENV);
    assert.deepEqual(readCart(v, "st_a", ENV), cart);
  });

  it("a tampered payload or signature reads as an empty cart", () => {
    const v = signCart(cart, ENV);
    const [payload, sig] = v.split(".") as [string, string];
    const body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    body.l[0][2] = 99; // bump a quantity
    const forged = `${Buffer.from(JSON.stringify(body)).toString("base64url")}.${sig}`;
    assert.deepEqual(readCart(forged, "st_a", ENV), emptyCart("st_a"));
    assert.deepEqual(readCart(`${payload}.${sig.slice(0, -2)}AA`, "st_a", ENV), emptyCart("st_a"));
    assert.deepEqual(readCart("garbage", "st_a", ENV), emptyCart("st_a"));
    assert.deepEqual(readCart("", "st_a", ENV), emptyCart("st_a"));
  });

  it("is bound to its store and to the server secret", () => {
    const v = signCart(cart, ENV);
    assert.deepEqual(readCart(v, "st_b", ENV), emptyCart("st_b"));
    assert.deepEqual(readCart(v, "st_a", { AUTH_SECRET: "another-secret-entirely-0000000000" }), emptyCart("st_a"));
    assert.deepEqual(readCart(v, "st_a", {}), emptyCart("st_a"));
    assert.throws(() => signCart(cart, {}), /AUTH_SECRET/);
    assert.notEqual(cartCookieName("st_a"), cartCookieName("st_b"));
  });

  it("a validly signed but malformed body is still refused", () => {
    // Sign a body with a quantity past the cap by going around addToCart.
    const v = signCart({ ...cart, lines: [{ productId: "p1", variantId: null, qty: CART_MAX_QTY + 1 }] }, ENV);
    assert.deepEqual(readCart(v, "st_a", ENV), emptyCart("st_a"));
  });

  it("add merges lines and caps quantities; set 0 removes; bad input is a CartError", () => {
    let c = addToCart(emptyCart("st_a"), "p1", null, 2);
    c = addToCart(c, "p1", null, 3);
    assert.deepEqual(c.lines, [{ productId: "p1", variantId: null, qty: 5 }]);
    c = addToCart(c, "p1", null, CART_MAX_QTY);
    assert.equal(c.lines[0]!.qty, CART_MAX_QTY);
    c = setCartQty(c, "p1", null, 0);
    assert.equal(c.lines.length, 0);
    assert.throws(() => addToCart(c, "p1", null, 0), CartError);
    assert.throws(() => addToCart(c, "p1", null, 1.5), CartError);
    assert.throws(() => addToCart(c, "../etc", null, 1), CartError);
    assert.equal(setCartPromo(c, " save10 ").promoCode, "SAVE10");
    assert.equal(setCartPromo(c, "").promoCode, null);
    assert.throws(() => setCartPromo(c, "no spaces allowed"), CartError);
  });
});

const item = (over: Partial<CatalogItem> = {}): CatalogItem => ({
  productId: "p1",
  variantId: "pvd_p1",
  publicVariantId: null,
  listingId: "l1",
  listingSlug: "mug",
  name: "Mug",
  sku: "MUG",
  productSku: "MUG",
  unitPriceCents: 1500,
  trackInventory: true,
  available: 10,
  sellable: true,
  ...over,
});

const promo = (over: Partial<PromotionRow> = {}): PromotionRow => ({
  id: "promo1",
  code: "SAVE10",
  rules: { percentOff: 10 },
  active: true,
  usageLimit: null,
  usedCount: 0,
  ...over,
});

describe("server-side pricing", () => {
  const catalog = new Map([
    [itemKey("p1", null), item()],
    [itemKey("p2", "v2"), item({ productId: "p2", variantId: "v2", publicVariantId: "v2", sku: "TEE-L", productSku: "TEE", name: "Tee — L", unitPriceCents: 2000, available: 1 })],
    [itemKey("p3", null), item({ productId: "p3", variantId: "pvd_p3", sku: "SVC", productSku: "SVC", name: "Setup", unitPriceCents: 5000, trackInventory: false, available: null })],
  ]);

  it("uses database prices only and totals in integer cents", () => {
    const p = priceCart({ lines: [{ productId: "p1", variantId: null, qty: 2 }, { productId: "p3", variantId: null, qty: 1 }], catalog, promoCode: null, promotion: null, taxRateBps: 0 });
    assert.equal(p.subtotalCents, 2 * 1500 + 5000);
    assert.equal(p.totalCents, 8000);
    assert.equal(p.checkoutReady, true);
    assert.equal(checkoutBlocker(p), null);
  });

  it("flags unknown items and short stock; checkout is refused with a reason", () => {
    const p = priceCart({ lines: [{ productId: "p2", variantId: "v2", qty: 3 }, { productId: "ghost", variantId: null, qty: 1 }], catalog, promoCode: null, promotion: null, taxRateBps: 0 });
    assert.deepEqual(p.lines[0]!.issue, { kind: "insufficient_stock", available: 1 });
    assert.deepEqual(p.lines[1]!.issue, { kind: "unavailable" });
    assert.equal(p.checkoutReady, false);
    assert.match(checkoutBlocker(p)!, /Only 1 of Tee — L left/);
    const out = priceCart({ lines: [{ productId: "p1", variantId: null, qty: 1 }], catalog: new Map([[itemKey("p1", null), item({ available: 0 })]]), promoCode: null, promotion: null, taxRateBps: 0 });
    assert.match(checkoutBlocker(out)!, /out of stock/);
    const unlisted = priceCart({ lines: [{ productId: "p1", variantId: null, qty: 1 }], catalog: new Map([[itemKey("p1", null), item({ sellable: false })]]), promoCode: null, promotion: null, taxRateBps: 0 });
    assert.match(checkoutBlocker(unlisted)!, /no longer available/);
    assert.equal(checkoutBlocker(priceCart({ lines: [], catalog, promoCode: null, promotion: null, taxRateBps: 0 })), "Your cart is empty.");
  });

  it("untracked items are always available", () => {
    const p = priceCart({ lines: [{ productId: "p3", variantId: null, qty: 50 }], catalog, promoCode: null, promotion: null, taxRateBps: 0 });
    assert.equal(p.lines[0]!.issue, null);
  });

  it("tax applies to the discounted subtotal, rounded half-up once", () => {
    // 3 × 1500 = 4500; 10% off → 4050; 8.25% tax → 334.125 → 334
    const p = priceCart({ lines: [{ productId: "p1", variantId: null, qty: 3 }], catalog, promoCode: "SAVE10", promotion: promo(), taxRateBps: 825 });
    assert.equal(p.discountCents, 450);
    assert.equal(p.taxCents, 334);
    assert.equal(p.totalCents, 4050 + 334);
    assert.equal(p.promo?.ok, true);
    assert.equal(p.promo?.promotionId, "promo1");
  });

  it("an unknown code is reported, not applied", () => {
    const p = priceCart({ lines: [{ productId: "p1", variantId: null, qty: 1 }], catalog, promoCode: "NOPE", promotion: null, taxRateBps: 0 });
    assert.equal(p.promo?.ok, false);
    assert.equal(p.discountCents, 0);
    assert.equal(p.totalCents, 1500);
    // The buyer must remove a dead code before paying a higher total.
    assert.equal(p.checkoutReady, false);
    assert.match(checkoutBlocker(p)!, /Code NOPE can't be used/);
  });

  it("promotion rules: usage limit, minimum subtotal, SKU scope by variant or product SKU", () => {
    const lines = [{ productId: "p1", variantId: null, qty: 1 }, { productId: "p2", variantId: "v2", qty: 1 }];
    const used = priceCart({ lines, catalog, promoCode: "SAVE10", promotion: promo({ usageLimit: 5, usedCount: 5 }), taxRateBps: 0 });
    assert.equal(used.promo?.ok, false);
    assert.match(used.promo!.reason!, /usage limit/);
    const min = priceCart({ lines, catalog, promoCode: "SAVE10", promotion: promo({ rules: { percentOff: 10, minSubtotalCents: 10_000 } }), taxRateBps: 0 });
    assert.equal(min.promo?.ok, false);
    const byProduct = priceCart({ lines, catalog, promoCode: "TEE", promotion: promo({ code: "TEE", rules: { amountOffCents: 500, productSkus: ["TEE"] } }), taxRateBps: 0 });
    assert.equal(byProduct.discountCents, 500);
    const byVariant = priceCart({ lines, catalog, promoCode: "TEE", promotion: promo({ code: "TEE", rules: { percentOff: 50, productSkus: ["TEE-L"] } }), taxRateBps: 0 });
    assert.equal(byVariant.discountCents, 1000);
    const capped = priceCart({ lines: [{ productId: "p1", variantId: null, qty: 1 }], catalog, promoCode: "BIG", promotion: promo({ code: "BIG", rules: { amountOffCents: 99_999 } }), taxRateBps: 0 });
    assert.equal(capped.discountCents, 1500);
    assert.equal(capped.totalCents, 0);
    assert.equal(capped.checkoutReady, false);
  });

  it("promotion window: not yet active / expired / open-ended", () => {
    const now = new Date("2026-10-04T12:00:00Z");
    const lines = [{ sku: "MUG", qty: 1, priceCents: 1000 }];
    assert.equal(evaluatePromotion({ ...promo(), startsAt: "2026-10-05T00:00:00Z" }, lines, now).ok, false);
    assert.equal(evaluatePromotion({ ...promo(), endsAt: "2026-10-04T12:00:00Z" }, lines, now).ok, false);
    assert.equal(evaluatePromotion({ ...promo(), startsAt: "2026-10-01T00:00:00Z", endsAt: "2026-10-31T00:00:00Z" }, lines, now).ok, true);
    assert.equal(evaluatePromotion({ ...promo(), startsAt: null, endsAt: null }, lines, now).ok, true);
  });

  it("the cart view never leaks anything but public fields", () => {
    const cart: Cart = { storeId: "s", lines: [{ productId: "p2", variantId: "v2", qty: 2 }], promoCode: null };
    const p = priceCart({ lines: cart.lines, catalog, promoCode: null, promotion: null, taxRateBps: 0 });
    const v = cartView(cart, p, "USD");
    assert.equal(v.lines[0]!.issue, "Only 1 left");
    assert.equal(v.count, 2);
    assert.deepEqual(Object.keys(v.lines[0]!).sort(), ["issue", "lineTotalCents", "listingId", "listingSlug", "name", "productId", "qty", "sku", "unitPriceCents", "variantId"]);
  });
});

describe("Stripe line items", () => {
  const lines = [{ name: "Mug", qty: 3, priceCents: 1500 }, { name: "Tee", qty: 1, priceCents: 2000 }];
  const sum = (xs: ReturnType<typeof stripeLineItems>) => xs.reduce((s, l) => s + l.quantity * l.price_data.unit_amount, 0);

  it("itemised without a discount, tax as its own line, sum = total", () => {
    const xs = stripeLineItems({ id: "ord_abcdef123456", totalCents: 6500 + 536, taxCents: 536, discountCents: 0 }, lines, "USD");
    assert.equal(xs.length, 3);
    assert.equal(xs[0]!.price_data.currency, "usd");
    assert.equal(sum(xs), 7036);
  });

  it("one order line with a discount (Stripe amounts can't go negative)", () => {
    const xs = stripeLineItems({ id: "ord_abcdef123456", totalCents: 5850, taxCents: 0, discountCents: 650, promotionCode: "SAVE10" }, lines, "EUR");
    assert.equal(xs.length, 1);
    assert.equal(sum(xs), 5850);
    assert.match(xs[0]!.price_data.product_data.name, /^Order SO-/);
  });

  it("refuses to send lines that don't add up", () => {
    assert.throws(() => stripeLineItems({ id: "o", totalCents: 1, taxCents: 0, discountCents: 0 }, lines, "USD"), /don't add up/);
  });
});

describe("web order posting + slugs", () => {
  it("Dr Cash total = Cr Sales net + Cr Tax", () => {
    const l = webOrderSaleLines({ totalCents: 4384, taxCents: 334 });
    assert.equal(assertBalanced(l), 4384);
    assert.deepEqual(l.map((x) => ("key" in x.account ? x.account.key : x.account.id)), ["cash", "sales", "tax_payable"]);
    assert.equal(webOrderSaleLines({ totalCents: 1000, taxCents: 0 }).length, 2);
    assert.deepEqual(webOrderSaleLines({ totalCents: 500, taxCents: 50 }, { id: "acct_vat" })[2]!.account, { id: "acct_vat" });
  });

  it("slugify", () => {
    assert.equal(slugify("Blue Mug (Large)"), "blue-mug-large");
    assert.equal(slugify("Café crème"), "cafe-creme");
    assert.equal(slugify("***"), "item");
  });
});
