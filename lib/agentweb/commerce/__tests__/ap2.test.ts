// Phase 21A round 2 (WS=agentweb): AP2 mandate shapes against a MOCK merchant agent (UNVERIFIED-LIVE),
// and the one thing that must stay true: human-not-present mandates are refused, always.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPaymentMandate, checkMerchantCart, createIntentMandate, HUMAN_NOT_PRESENT_SUPPORTED, HumanNotPresentRefused, minorToDecimal, toAp2CartContents, verifyJwt } from "../ap2";
import { MandateRequired } from "../checkout";
import { normalizeCart } from "../cart";
import { mandateContents, signMandate, verifyMandate } from "../mandate";
import { generateKeyPair } from "../../identity/httpsig";
import { mockAp2Merchant } from "../fakes";

const SECRET = "c".repeat(40);
const NOW = new Date("2026-10-10T12:00:00.000Z");
const NOW_SEC = Math.floor(NOW.getTime() / 1000);
const cart = normalizeCart({ merchant: { name: "Acme shop", origin: "https://acme.test" }, currency: "GBP", items: [{ sku: "MUG", name: "Blue mug", qty: 2, unitMinor: 1250 }] });
const verified = (() => {
  const signed = signMandate(mandateContents({ id: "man_1", workspaceId: "w1", cart, expiresAt: new Date(NOW.getTime() + 1_800_000) }), { userId: "u1", channel: "ui_click", role: "editor" }, SECRET, NOW);
  const r = verifyMandate(signed, { secret: SECRET, now: NOW, cart, workspaceId: "w1" });
  if (!r.ok) throw new Error(r.reason);
  return r.mandate;
})();

describe("minorToDecimal", () => {
  it("formats by currency exponent", () => {
    assert.equal(minorToDecimal(2500, "GBP"), "25.00");
    assert.equal(minorToDecimal(5, "USD"), "0.05");
    assert.equal(minorToDecimal(1500, "JPY"), "1500");
    assert.equal(minorToDecimal(1234, "BHD"), "1.234");
  });
});

describe("toAp2CartContents", () => {
  it("maps the approved cart to AP2 CartContents, always asking a person to confirm", () => {
    const c = toAp2CartContents(verified);
    assert.equal(c.user_cart_confirmation_required, true);
    assert.deepEqual([c.id, c.merchant_name, c.cart_expiry], ["man_1", "Acme shop", verified.contents.expiresAt]);
    assert.deepEqual(c.payment_request.details.total, { label: "Total", amount: { currency: "GBP", value: "25.00" } });
    assert.deepEqual(c.payment_request.details.display_items, [{ label: "Blue mug × 2", amount: { currency: "GBP", value: "25.00" } }]);
  });
  it("refuses anything but a verified mandate", () => {
    assert.throws(() => toAp2CartContents({ ...verified }), MandateRequired);
  });
});

describe("merchant cart check and payment mandate", () => {
  const merchant = mockAp2Merchant();
  const approved = toAp2CartContents(verified);

  it("accepts the merchant's signed cart when it is what the person approved", () => {
    assert.deepEqual(checkMerchantCart(verified, merchant.signCart(approved, { now: NOW_SEC }), merchant.key.x, NOW_SEC), { ok: true });
  });

  it("rejects a cart the merchant changed, an unsigned one, a forged signature and an expired token", () => {
    const dearer = { ...approved, payment_request: { ...approved.payment_request, details: { ...approved.payment_request.details, total: { label: "Total", amount: { currency: "GBP", value: "99.00" } } } } };
    assert.deepEqual(checkMerchantCart(verified, merchant.signCart(dearer, { now: NOW_SEC }), merchant.key.x, NOW_SEC), { ok: false, reason: "not_what_was_approved" });
    assert.deepEqual(checkMerchantCart(verified, { contents: approved, merchant_authorization: null }, merchant.key.x, NOW_SEC), { ok: false, reason: "unsigned" });
    assert.deepEqual(checkMerchantCart(verified, merchant.signCart(approved, { now: NOW_SEC }), generateKeyPair().x, NOW_SEC), { ok: false, reason: "bad_merchant_signature" });
    assert.deepEqual(checkMerchantCart(verified, merchant.signCart(approved, { now: NOW_SEC - 1000, ttlSec: 300 }), merchant.key.x, NOW_SEC), { ok: false, reason: "expired_token" });
    const tampered = merchant.signCart(approved, { now: NOW_SEC });
    assert.deepEqual(checkMerchantCart(verified, { ...tampered, contents: dearer }, merchant.key.x, NOW_SEC), { ok: false, reason: "hash_mismatch" });
  });

  it("the payment mandate carries a server attestation of the click, bound to the cart and payment hashes", () => {
    const key = generateKeyPair();
    const cartMandate = merchant.signCart(approved, { now: NOW_SEC });
    const pm = buildPaymentMandate(verified, cartMandate, { merchantAgent: "mock-merchant-agent", signingKey: key, now: NOW, nonce: "abc" });
    assert.equal(pm.payment_mandate_contents.payment_details_total.amount.value, "25.00");
    const claims = verifyJwt(pm.user_authorization, key.x)!;
    assert.equal(claims.aud, "mock-merchant-agent");
    assert.equal(claims.sub, "u1");
    assert.equal((claims.transaction_data as string[]).length, 2);
    assert.match(String(claims.attestation), /not a device-bound wallet credential/);
  });

  it("will not build a payment mandate from an unverified mandate", () => {
    assert.throws(() => buildPaymentMandate({ ...verified }, merchant.signCart(approved), { merchantAgent: "m", signingKey: generateKeyPair(), now: NOW, nonce: "n" }), MandateRequired);
  });
});

describe("human-not-present intent mandates are NOT supported", () => {
  it("createIntentMandate always refuses, whatever it is given", () => {
    assert.equal(HUMAN_NOT_PRESENT_SUPPORTED, false);
    for (const input of [undefined, {}, { user_cart_confirmation_required: false, natural_language_description: "buy trainers under £100", intent_expiry: "2027-01-01T00:00:00Z" }, { user_cart_confirmation_required: true }]) {
      assert.throws(() => createIntentMandate(input), HumanNotPresentRefused);
    }
  });
  it("the refusal explains why in plain words", () => {
    try {
      createIntentMandate();
    } catch (e) {
      assert.match((e as Error).message, /never approved automatically/);
    }
  });
});
