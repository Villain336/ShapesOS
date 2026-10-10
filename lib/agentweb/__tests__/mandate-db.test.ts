// Phase 21A round 2 (WS=agentweb): cart mandates on real Postgres as the app role.
//   - an agent's request is pending; ONLY a ui_click by an editor+ signs it (voice, chat
//     confirmation, API key, agent: refused, and the row stays pending);
//   - a signed mandate is consumed exactly once, and only for the cart it was signed for;
//     a different cart, an expired mandate or an unsigned one is rejected;
//   - FORCE RLS: another workspace cannot see, sign or consume it; no GUC sees nothing;
//   - the audit chain records request, signature (via ui_click) and rejection, never card data.
// Listed in scripts/test/db-tests.txt.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

process.env.MARKETR_CREDENTIALS_KEY ||= randomBytes(32).toString("hex");

import { prisma } from "@/lib/prisma";
import { normalizeCart } from "../commerce/cart";
import { MandateRefused } from "../commerce/mandate";
import { consumeMandate, createMandate, getMandate, listMandates, MandateStoreError, MAX_PENDING_MANDATES, rejectMandateById, signMandateById } from "../commerce/mandate-store";

const RUN = `p21mn-${Date.now().toString(36)}`;
const A = `${RUN}-a`;
const B = `${RUN}-b`;
const CART = { merchant: { name: "Acme shop", origin: "https://acme.test" }, currency: "GBP", items: [{ sku: "MUG", name: "Blue mug", qty: 2, unitMinor: 1250 }] };
const click = { userId: "alice", role: "editor", channel: "ui_click" as const };

before(async () => {
  for (const id of [A, B]) await prisma.workspace.create({ data: { id, name: id, ownerUserId: `${id}-owner`, plan: "pro" } });
});
after(async () => {
  await prisma.workspace.deleteMany({ where: { id: { in: [A, B] } } });
  await prisma.$disconnect();
});

describe("who can sign", () => {
  it("an agent's request is pending, and nothing but a ui_click by an editor signs it", async () => {
    const m = await createMandate(A, { requestedBy: "agent:lead", runId: "run_1", cart: CART });
    assert.deepEqual([m.status, m.amountMinor, m.currency, m.runId, m.merchantOrigin], ["pending", 2500, "GBP", "run_1", "https://acme.test"]);
    for (const channel of ["voice", "spoken", "chat_confirm", "api_key", "agent", "automation"]) {
      await assert.rejects(() => signMandateById(A, m.id, { ...click, channel: channel as never }), (e: unknown) => e instanceof MandateRefused && e.code === "channel", channel);
    }
    await assert.rejects(() => signMandateById(A, m.id, { ...click, role: "viewer" }), (e: unknown) => e instanceof MandateRefused && e.code === "role");
    assert.equal((await getMandate(A, m.id))!.status, "pending", "still pending after every refused attempt");
    const signed = await signMandateById(A, m.id, click);
    assert.deepEqual([signed.status, signed.signedBy], ["signed", "alice"]);
    await assert.rejects(() => signMandateById(A, m.id, click), (e: unknown) => e instanceof MandateStoreError && e.code === "not_pending");
  });

  it("an expired request cannot be signed", async () => {
    const past = new Date(Date.now() - 3 * 3_600_000);
    const m = await createMandate(A, { requestedBy: "agent:lead", cart: CART, ttlMs: 60_000 }, past);
    assert.equal((await getMandate(A, m.id))!.status, "expired");
    await assert.rejects(() => signMandateById(A, m.id, click), (e: unknown) => e instanceof MandateStoreError && e.code === "not_pending");
  });

  it("only a few carts can wait at once", async () => {
    const wsC = `${RUN}-c`;
    await prisma.workspace.create({ data: { id: wsC, name: wsC, ownerUserId: `${wsC}-owner`, plan: "pro" } });
    try {
      for (let i = 0; i < MAX_PENDING_MANDATES; i++) await createMandate(wsC, { requestedBy: "agent:lead", cart: CART });
      await assert.rejects(() => createMandate(wsC, { requestedBy: "agent:lead", cart: CART }), (e: unknown) => e instanceof MandateStoreError && e.code === "too_many_pending");
    } finally {
      await prisma.workspace.delete({ where: { id: wsC } });
    }
  });
});

describe("consuming a signed mandate", () => {
  it("works once, only for the cart that was signed, and only after signing", async () => {
    const m = await createMandate(A, { requestedBy: "agent:lead", cart: CART });
    const cart = normalizeCart(CART);
    await assert.rejects(() => consumeMandate(A, m.id, cart), (e: unknown) => e instanceof MandateStoreError && e.code === "not_signed");
    await signMandateById(A, m.id, click);
    const other = normalizeCart({ ...CART, items: [{ sku: "MUG", name: "Blue mug", qty: 9, unitMinor: 1250 }] });
    await assert.rejects(() => consumeMandate(A, m.id, other), (e: unknown) => e instanceof MandateStoreError && e.code === "cart_mismatch");
    assert.equal((await getMandate(A, m.id))!.status, "signed", "a failed attempt does not use it up");
    const v = await consumeMandate(A, m.id, cart);
    assert.equal(v.contents.amountMinor, 2500);
    await assert.rejects(() => consumeMandate(A, m.id, cart), (e: unknown) => e instanceof MandateStoreError && e.code === "already_used");
    assert.equal((await getMandate(A, m.id))!.status, "used");
  });

  it("two checkouts racing for one mandate: exactly one wins", async () => {
    const m = await createMandate(A, { requestedBy: "agent:lead", cart: CART });
    await signMandateById(A, m.id, click);
    const cart = normalizeCart(CART);
    const results = await Promise.allSettled([consumeMandate(A, m.id, cart), consumeMandate(A, m.id, cart), consumeMandate(A, m.id, cart)]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  });

  it("an expired signed mandate is rejected", async () => {
    const m = await createMandate(A, { requestedBy: "agent:lead", cart: CART });
    await signMandateById(A, m.id, click);
    await assert.rejects(() => consumeMandate(A, m.id, normalizeCart(CART), new Date(Date.now() + 3 * 3_600_000)), (e: unknown) => e instanceof MandateStoreError && e.code === "expired");
  });

  it("a rejected request can never be used", async () => {
    const m = await createMandate(A, { requestedBy: "agent:lead", cart: CART });
    await rejectMandateById(A, m.id, "alice");
    await assert.rejects(() => signMandateById(A, m.id, click), (e: unknown) => e instanceof MandateStoreError);
    await assert.rejects(() => consumeMandate(A, m.id, normalizeCart(CART)), (e: unknown) => e instanceof MandateStoreError && e.code === "not_signed");
  });
});

describe("isolation and the audit trail", () => {
  it("another workspace sees, signs and consumes nothing; no GUC sees no rows", async () => {
    const m = await createMandate(A, { requestedBy: "agent:lead", cart: CART });
    assert.equal(await getMandate(B, m.id), null);
    assert.deepEqual((await listMandates(B)).map((x) => x.id), []);
    await assert.rejects(() => signMandateById(B, m.id, click), (e: unknown) => e instanceof MandateStoreError && e.code === "not_found");
    assert.equal((await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM agentweb_mandates`)[0]!.n, 0);
  });

  it("the audit chain records the request and the signature via ui_click, with no card data", async () => {
    const m = await createMandate(A, { requestedBy: "agent:lead", cart: CART });
    await signMandateById(A, m.id, click);
    const events = await prisma.authorityAuditEvent.findMany({ where: { workspaceId: A, entityId: m.id }, orderBy: { ts: "asc" } });
    assert.deepEqual(events.map((e) => e.action), ["agentweb.mandate.requested", "agentweb.mandate.signed"]);
    const signed = events[1]!.detail as { via: string; amountMinor: number };
    assert.deepEqual([signed.via, signed.amountMinor, events[1]!.actor], ["ui_click", 2500, "user:alice"]);
    assert.ok(!/\b\d{13,19}\b/.test(JSON.stringify(events.map((e) => e.detail))));
  });

  it("a card number in a cart is refused at creation and nothing is stored", async () => {
    await assert.rejects(() => createMandate(A, { requestedBy: "agent:lead", cart: { ...CART, items: [{ name: "Gift 4242 4242 4242 4242", qty: 1, unitMinor: 100 }] } }), /card/i);
  });
});
