// Phase 21A round 2 (WS=agentweb): checkout against a MOCK ACP merchant (no live merchant exists;
// live behaviour is UNVERIFIED-LIVE). The point of these tests is the gate, not the merchant:
//   - a checkout cannot complete without a mandate the person signed for exactly this cart;
//   - a mandate for another cart, an expired one or an unverified lookalike is refused, and the
//     merchant is never asked to complete;
//   - a price that moved since the person signed cancels the checkout instead of paying more;
//   - without an adapter or a payment rail the agent STOPS at the payment step for the person;
//   - card numbers never reach the merchant or a log.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AcpAdapter, ACP_API_VERSION } from "../acp";
import { completeCheckout, MandateRequired, noPaymentRail, planCheckout } from "../checkout";
import { CardDataError, normalizeCart } from "../cart";
import { mandateContents, signMandate, verifyMandate } from "../mandate";
import { mockAcpMerchant, mockPaymentRail } from "../fakes";

const SECRET = "c".repeat(40);
const NOW = new Date("2026-10-10T12:00:00.000Z");
const cart = normalizeCart({ merchant: { name: "Acme shop", origin: "https://acme.test" }, currency: "GBP", items: [{ sku: "MUG", name: "Blue mug", qty: 2, unitMinor: 1250 }] });
const resolve = async () => ["93.184.216.34"];

function signedFor(c = cart, over: { expiresInMs?: number } = {}) {
  const contents = mandateContents({ id: "man_1", workspaceId: "w1", cart: c, expiresAt: new Date(NOW.getTime() + (over.expiresInMs ?? 1_800_000)) });
  const signed = signMandate(contents, { userId: "u1", channel: "ui_click", role: "editor" }, SECRET, NOW);
  const r = verifyMandate(signed, { secret: SECRET, now: NOW, cart: c, workspaceId: "w1" });
  if (!r.ok) throw new Error(r.reason);
  return { signed, verified: r.mandate };
}
const adapterFor = (merchant: ReturnType<typeof mockAcpMerchant>) => new AcpAdapter({ baseUrl: "https://acme.test/acp", bearerToken: "mock-merchant-token", fetchFn: merchant.fetchFn, resolve });

describe("planCheckout", () => {
  it("uses ACP when the merchant offers it; otherwise the person finishes at the merchant", () => {
    assert.equal(planCheckout({ acp: { baseUrl: "https://acme.test/acp" } }).path, "acp");
    assert.equal(planCheckout({}).path, "handoff");
    assert.equal(planCheckout({ ap2: true }).path, "handoff", "AP2 is never chosen automatically");
  });
});

describe("completeCheckout needs a signed mandate", () => {
  it("completes with a verified mandate for this cart, speaking ACP as the spec says", async () => {
    const merchant = mockAcpMerchant();
    const out = await completeCheckout(adapterFor(merchant), { cart, mandate: signedFor().verified, rail: mockPaymentRail });
    assert.equal(out.outcome, "completed");
    if (out.outcome === "completed") assert.deepEqual([out.order.id, out.amountMinor], ["ord_mock_cs_mock_1", 2500]);
    const create = merchant.calls[0]!;
    assert.deepEqual([create.method, create.path, create.headers["api-version"], create.headers.authorization], ["POST", "/acp/checkout_sessions", ACP_API_VERSION, "Bearer mock-merchant-token"]);
    assert.deepEqual(create.body, { currency: "gbp", line_items: [{ id: "MUG", name: "Blue mug", quantity: 2, unit_amount: 1250 }] });
    assert.match(create.headers["idempotency-key"]!, /^[0-9a-f]{32}$/);
    assert.ok(create.headers["user-agent"]!.startsWith("ShapesOS-Agent/"));
    assert.deepEqual(merchant.calls.map((c) => c.path.split("/").pop()), ["checkout_sessions", "complete"]);
  });

  it("an unsigned, hand-built or merely 'signed' mandate cannot complete: the merchant is never asked", async () => {
    const merchant = mockAcpMerchant();
    const { signed } = signedFor();
    for (const fake of [undefined, null, {}, signed, { ...signed }, JSON.parse(JSON.stringify(signed))]) {
      await assert.rejects(() => completeCheckout(adapterFor(merchant), { cart, mandate: fake, rail: mockPaymentRail }), MandateRequired);
    }
    assert.equal(merchant.calls.length, 0);
    assert.equal(merchant.completeCount(), 0);
  });

  it("the adapter refuses on its own too (defence in depth), even when called directly", async () => {
    const merchant = mockAcpMerchant();
    const a = adapterFor(merchant);
    const { signed, verified } = signedFor();
    await assert.rejects(() => a.createSession(cart, signed as never), MandateRequired);
    const session = await a.createSession(cart, verified);
    await assert.rejects(() => a.complete(session, signed as never, { handlerId: "h", token: "t", tokenType: "shared_payment_token" }), MandateRequired);
    assert.equal(merchant.completeCount(), 0);
  });

  it("a mandate for a DIFFERENT cart never verifies, so it never reaches checkout", () => {
    const { signed } = signedFor();
    const other = normalizeCart({ ...cart, items: [{ sku: "MUG", name: "Blue mug", qty: 5, unitMinor: 1250 }] });
    assert.deepEqual(verifyMandate(signed, { secret: SECRET, now: NOW, cart: other, workspaceId: "w1" }), { ok: false, reason: "cart_mismatch" });
  });

  it("an expired mandate never verifies", () => {
    const { signed } = signedFor();
    assert.deepEqual(verifyMandate(signed, { secret: SECRET, now: new Date(NOW.getTime() + 3_600_000), cart, workspaceId: "w1" }), { ok: false, reason: "expired" });
  });
});

describe("what the merchant can and cannot do to the person", () => {
  it("a price that moved since signing cancels the checkout; nothing is completed", async () => {
    const merchant = mockAcpMerchant();
    merchant.setPriceDrift(500);
    const out = await completeCheckout(adapterFor(merchant), { cart, mandate: signedFor().verified, rail: mockPaymentRail });
    assert.deepEqual(out, { outcome: "price_changed", expectedMinor: 2500, gotMinor: 3000, currency: "GBP" });
    assert.equal(merchant.completeCount(), 0);
    assert.ok(merchant.calls.some((c) => c.path.endsWith("/cancel")));
  });

  it("no adapter, or no payment rail: the agent stops at the payment step with a link for the person", async () => {
    const merchant = mockAcpMerchant();
    const { verified } = signedFor();
    assert.deepEqual(await completeCheckout(null, { cart, mandate: verified, rail: mockPaymentRail, fallbackUrl: "https://acme.test/cart" }), { outcome: "stopped_at_payment", reason: "no_adapter", continueUrl: "https://acme.test/cart" });
    assert.deepEqual(await completeCheckout(adapterFor(merchant), { cart, mandate: verified, rail: noPaymentRail, fallbackUrl: "https://acme.test/cart" }), { outcome: "stopped_at_payment", reason: "no_payment_rail", continueUrl: "https://acme.test/cart" });
    assert.equal(merchant.calls.length, 0);
  });

  it("a wrong merchant token is a refusal, not a retry", async () => {
    const merchant = mockAcpMerchant({ token: "other" });
    await assert.rejects(() => completeCheckout(adapterFor(merchant), { cart, mandate: signedFor().verified, rail: mockPaymentRail }), /refused the request \(401\)/);
  });
});

describe("card details never travel", () => {
  it("a card number in a cart is refused before anything is built", () => {
    assert.throws(() => normalizeCart({ ...cart, items: [{ name: "Gift 4242 4242 4242 4242", qty: 1, unitMinor: 1 }] }), CardDataError);
  });

  it("a payment credential that is a card number is refused, and never sent", async () => {
    const merchant = mockAcpMerchant();
    const rail = { credential: async () => ({ handlerId: "h", token: "4242424242424242", tokenType: "card" }) };
    await assert.rejects(() => completeCheckout(adapterFor(merchant), { cart, mandate: signedFor().verified, rail }), CardDataError);
    assert.equal(merchant.calls.length, 0);
  });

  it("nothing the merchant received contains a card-like number", async () => {
    const merchant = mockAcpMerchant();
    await completeCheckout(adapterFor(merchant), { cart, mandate: signedFor().verified, rail: mockPaymentRail });
    assert.ok(!/\b\d{13,19}\b/.test(JSON.stringify(merchant.calls)));
  });
});
