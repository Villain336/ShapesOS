// Phase 21A round 2 (WS=agentweb): the cart mandate (PURE). A person's authorisation of ONE
// cart, signed only by a click on the Tier 3 card. This is where "money is never auto" is
// enforced for web commerce:
//   - only a ui_click can sign: a voice or spoken yes, an API key, an agent, an automation
//     rule or a webhook cannot, whatever it claims;
//   - it binds to the cart hash, the amount, the currency, the merchant, the run, the
//     workspace and an expiry; a mandate for another cart, or after expiry, is rejected;
//   - there is no "unsigned" mode: without a signing secret nothing can be signed.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isVerified, MandateRefused, mandateContents, signMandate, verifyMandate } from "../mandate";
import { normalizeCart } from "../cart";

const SECRET = "m".repeat(40);
const NOW = new Date("2026-10-10T12:00:00.000Z");
const cart = normalizeCart({ merchant: { name: "Acme shop", origin: "https://acme.test" }, currency: "GBP", items: [{ sku: "MUG", name: "Blue mug", qty: 2, unitMinor: 1250 }], runId: "run_1" });
const EXPIRES = new Date(NOW.getTime() + 30 * 60_000);
const contents = () => mandateContents({ id: "man_1", workspaceId: "w1", cart, expiresAt: EXPIRES, nonce: "n-1" });
const click = { userId: "u1", channel: "ui_click" as const, role: "editor" as const };

describe("who can sign", () => {
  it("a ui_click by an editor or above signs", () => {
    const m = signMandate(contents(), click, SECRET, NOW);
    assert.deepEqual([m.signedBy, m.via, m.alg, m.signedAt], ["u1", "ui_click", "hmac-sha256", NOW.toISOString()]);
  });

  it("nothing else can: voice, spoken, chat confirmation, API key, agent, automation, webhook, MCP", () => {
    for (const channel of ["voice", "spoken", "chat_confirm", "api_key", "agent", "automation", "webhook", "mcp", "", "UI_CLICK ", "ui-click"]) {
      assert.throws(() => signMandate(contents(), { ...click, channel: channel as never }, SECRET, NOW), (e: unknown) => e instanceof MandateRefused && e.code === "channel", channel);
    }
  });

  it("a viewer cannot, and a missing person cannot", () => {
    assert.throws(() => signMandate(contents(), { ...click, role: "viewer" as never }, SECRET, NOW), (e: unknown) => e instanceof MandateRefused && e.code === "role");
    assert.throws(() => signMandate(contents(), { ...click, userId: "" }, SECRET, NOW), (e: unknown) => e instanceof MandateRefused && e.code === "person");
  });

  it("there is no unsigned mode: without a secret nothing is signed", () => {
    assert.throws(() => signMandate(contents(), click, null, NOW), (e: unknown) => e instanceof MandateRefused && e.code === "no_secret");
  });

  it("an already expired mandate cannot be signed", () => {
    assert.throws(() => signMandate(contents(), click, SECRET, new Date(EXPIRES.getTime() + 1)), (e: unknown) => e instanceof MandateRefused && e.code === "expired");
  });
});

describe("what a verified mandate proves", () => {
  const signed = signMandate(contents(), click, SECRET, NOW);
  const ok = (over: Partial<Parameters<typeof verifyMandate>[1]> = {}) => verifyMandate(signed, { secret: SECRET, now: NOW, cart, workspaceId: "w1", ...over });

  it("verifies for the same cart, workspace and time", () => {
    const r = ok();
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(isVerified(r.mandate), true);
  });

  it("a mandate for a DIFFERENT cart is rejected", () => {
    const other = normalizeCart({ ...cart, items: [{ sku: "MUG", name: "Blue mug", qty: 3, unitMinor: 1250 }] });
    assert.deepEqual(ok({ cart: other }), { ok: false, reason: "cart_mismatch" });
    const otherMerchant = normalizeCart({ ...cart, merchant: { name: "Acme shop", origin: "https://evil.test" } });
    assert.deepEqual(ok({ cart: otherMerchant }), { ok: false, reason: "cart_mismatch" });
  });

  it("a mandate after its expiry is rejected", () => {
    assert.deepEqual(ok({ now: new Date(EXPIRES.getTime() + 1) }), { ok: false, reason: "expired" });
  });

  it("another workspace's mandate is rejected", () => {
    assert.deepEqual(ok({ workspaceId: "w2" }), { ok: false, reason: "wrong_workspace" });
  });

  it("any edited field breaks the signature", () => {
    const edits: Array<(m: typeof signed) => typeof signed> = [
      (m) => ({ ...m, contents: { ...m.contents, amountMinor: 1 } }),
      (m) => ({ ...m, contents: { ...m.contents, merchant: { ...m.contents.merchant, origin: "https://evil.test" } } }),
      (m) => ({ ...m, contents: { ...m.contents, expiresAt: new Date(NOW.getTime() + 999 * 60_000).toISOString() } }),
      (m) => ({ ...m, contents: { ...m.contents, runId: "run_2" } }),
      (m) => ({ ...m, signedBy: "u2" }),
      (m) => ({ ...m, contents: { ...m.contents, nonce: "other" } }),
    ];
    for (const edit of edits) assert.equal(verifyMandate(edit(signed), { secret: SECRET, now: NOW, cart, workspaceId: "w1" }).ok, false);
  });

  it("a mandate whose own numbers disagree is rejected even if someone re-signed it", () => {
    // contents say 1 minor unit but the items add up to 2500: caught as an amount mismatch
    const lying = signMandate({ ...contents(), amountMinor: 1 }, click, SECRET, NOW);
    assert.deepEqual(verifyMandate(lying, { secret: SECRET, now: NOW, cart, workspaceId: "w1" }), { ok: false, reason: "amount_mismatch" });
  });

  it("is not accepted under another secret, or when no secret is configured", () => {
    assert.deepEqual(ok({ secret: "x".repeat(40) }), { ok: false, reason: "bad_signature" });
    assert.deepEqual(ok({ secret: null }), { ok: false, reason: "no_secret" });
  });

  it("the verified marker cannot be forged by building an object", () => {
    assert.equal(isVerified({ ...signed }), false);
    assert.equal(isVerified(signed), false);
  });
});

describe("mandateContents", () => {
  it("binds the cart hash, amount, currency, merchant, run and workspace, with a fresh nonce by default", () => {
    const a = mandateContents({ id: "man_1", workspaceId: "w1", cart, expiresAt: EXPIRES });
    const b = mandateContents({ id: "man_1", workspaceId: "w1", cart, expiresAt: EXPIRES });
    assert.notEqual(a.nonce, b.nonce);
    assert.deepEqual([a.amountMinor, a.currency, a.merchant.origin, a.runId, a.workspaceId, a.expiresAt], [2500, "GBP", "https://acme.test", "run_1", "w1", EXPIRES.toISOString()]);
    assert.match(a.cartHash, /^[0-9a-f]{64}$/);
  });
});
