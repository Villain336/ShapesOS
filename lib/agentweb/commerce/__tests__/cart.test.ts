// Phase 21A round 2 (WS=agentweb): cart objects (PURE). A cart is data the person is
// asked to approve, so it is validated hard, hashed canonically, and can never carry card data.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertNoCardData, CardDataError, cartHash, CartError, normalizeCart, totalMinor } from "../cart";

const INPUT = {
  merchant: { name: "Acme shop", origin: "https://acme.test/some/page" },
  currency: "gbp",
  items: [
    { sku: "MUG-B", name: "Blue mug", qty: 2, unitMinor: 1250 },
    { name: "Tee", qty: 1, unitMinor: 1800 },
  ],
};

describe("normalizeCart and totalMinor", () => {
  it("normalises the origin and currency, keeps the items, and adds up in minor units", () => {
    const c = normalizeCart(INPUT);
    assert.equal(c.merchant.origin, "https://acme.test");
    assert.equal(c.currency, "GBP");
    assert.equal(totalMinor(c), 2 * 1250 + 1800);
  });

  it("refuses what is not a sane cart", () => {
    const bad: Array<[string, unknown]> = [
      ["no items", { ...INPUT, items: [] }],
      ["fractional quantity", { ...INPUT, items: [{ name: "x", qty: 1.5, unitMinor: 100 }] }],
      ["zero quantity", { ...INPUT, items: [{ name: "x", qty: 0, unitMinor: 100 }] }],
      ["negative price", { ...INPUT, items: [{ name: "x", qty: 1, unitMinor: -1 }] }],
      ["float price", { ...INPUT, items: [{ name: "x", qty: 1, unitMinor: 9.99 }] }],
      ["bad currency", { ...INPUT, currency: "POUNDS" }],
      ["non-web merchant", { ...INPUT, merchant: { name: "x", origin: "javascript:alert(1)" } }],
      ["too many items", { ...INPUT, items: Array.from({ length: 51 }, (_, i) => ({ name: `i${i}`, qty: 1, unitMinor: 1 })) }],
      ["absurd total", { ...INPUT, items: [{ name: "x", qty: 99, unitMinor: 100_000_000 }] }],
    ];
    for (const [label, input] of bad) assert.throws(() => normalizeCart(input), CartError, label);
  });

  it("strips control characters and clips names", () => {
    const c = normalizeCart({ ...INPUT, items: [{ name: `Mug\u0000‮${"x".repeat(300)}`, qty: 1, unitMinor: 1 }] });
    assert.ok(c.items[0]!.name.length <= 120);
    assert.ok(!/[\u0000-\u001f‮]/.test(c.items[0]!.name));
  });
});

describe("cartHash", () => {
  it("is the sha256 of the canonical JSON (keys sorted), matching an independent computation", () => {
    assert.equal(cartHash(normalizeCart(INPUT)), "1ccdf325cf5978ec9b45683ae1810a06760dbf8bf317f94482e48bead2f62900");
  });

  it("changes when anything the person approves changes, and not when only the run does", () => {
    const base = cartHash(normalizeCart(INPUT));
    assert.notEqual(cartHash(normalizeCart({ ...INPUT, currency: "USD" })), base);
    assert.notEqual(cartHash(normalizeCart({ ...INPUT, items: [{ ...INPUT.items[0]!, qty: 3 }, INPUT.items[1]!] })), base);
    assert.notEqual(cartHash(normalizeCart({ ...INPUT, merchant: { ...INPUT.merchant, origin: "https://evil.test" } })), base);
    assert.equal(cartHash(normalizeCart({ ...INPUT, runId: "run_1" })), base);
  });
});

describe("assertNoCardData", () => {
  it("refuses a card number anywhere in a value, however it is spaced", () => {
    for (const v of ["4242424242424242", "4242 4242 4242 4242", "card: 4242-4242-4242-4242 exp", { deep: { n: ["5555555555554444"] } }]) assert.throws(() => assertNoCardData(v), CardDataError);
  });
  it("refuses card-ish field names carrying a value", () => {
    assert.throws(() => assertNoCardData({ cvv: "123" }), CardDataError);
    assert.throws(() => assertNoCardData({ "cc-number": "x" }), CardDataError);
  });
  it("lets ordinary numbers through (order numbers, prices, SKUs that fail Luhn)", () => {
    assert.doesNotThrow(() => assertNoCardData({ sku: "1234567890123", price: 1999, order: "ORD-2026-000123" }));
  });
  it("never echoes the value in its message", () => {
    try {
      assertNoCardData("pay with 4242 4242 4242 4242");
      assert.fail("should throw");
    } catch (e) {
      assert.ok(!/4242/.test((e as Error).message));
    }
  });
});
