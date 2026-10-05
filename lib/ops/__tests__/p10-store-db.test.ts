// ShapesOS — Phase 10 (store): the storefront on real Postgres, as the
// least-privilege app role.
//   - only PUBLISHED stores resolve (the SELECT-only routing policy);
//     unpublished / unknown → null; no GUC → nothing
//   - RLS: store A can't list or sell store B's products; a listing can't
//     point at another workspace's product
//   - no tenant Stripe key → checkout refused, nothing created
//   - checkout re-prices from the database (a price change after the cart
//     was built wins), refuses short stock, creates a draft web order
//   - ONE signed webhook → order confirmed + OpsPayment (real payment intent
//     id) + stock sale txn + balanced journal entry + promotion usedCount 1;
//     redelivery (same or new event id) changes nothing
//   - amount mismatch is flagged, never applied; expiry cancels an unpaid
//     draft and never a paid order
// Stripe: the real SDK signs/verifies webhook payloads offline; Checkout
// Session creation is a labelled STUB (no network, no live Stripe account).
// Run: DATABASE_URL=<app role url> MARKETR_CREDENTIALS_KEY=… npx tsx --test lib/ops/__tests__/p10-store-db.test.ts

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import Stripe from "stripe";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { OPS_ENTITY_MAP } from "../entities";
import { OpsError, opsCreate, opsPatch, type OpsActor } from "../doctype";
import { handleStripeWebhook, saveFinanceSettings, type StripeFactory, type StripeLike } from "../finance/stripe";
import { findEntryBySource } from "../accounting";
import { addToCart, emptyCart, setCartPromo, type Cart } from "../store/cart";
import { catalogForCart, loadPublicListing, loadPublicListings, priceCartFor, resolvePublishedStore, type PublicStore } from "../store/catalog";
import { createStoreCheckout, StoreNotConnectedError } from "../store/checkout";
import { storeOverview } from "../store/admin";
import { storeListProductCore, storeOverviewCore } from "@/lib/chat/ops-store-tools";

const WS_A = "p10store-ws-a";
const WS_B = "p10store-ws-b";
const A: OpsActor = { workspaceId: WS_A, userId: "user-p10store-a" };
const B: OpsActor = { workspaceId: WS_B, userId: "user-p10store-b" };
const def = (slug: string) => OPS_ENTITY_MAP[slug]!;
const SECRET_KEY = "sk_test_51Hp10storeabcdefghij";
const WHSEC = "whsec_p10storetestsecret123";

// The real SDK: offline signature generation + verification.
const sdk = new Stripe(SECRET_KEY);
// STUB (labelled): Checkout Session creation never reaches Stripe.
const created: Array<Record<string, unknown>> = [];
let sessionSeq = 0;
const stubStripe: StripeFactory = () =>
  ({
    checkout: {
      sessions: {
        create: async (params: Record<string, unknown>) => {
          created.push(params);
          sessionSeq += 1;
          return { id: `cs_test_stub_${sessionSeq}`, url: `https://checkout.stripe.test/stub/${sessionSeq}` };
        },
      },
    },
    webhooks: sdk.webhooks,
  }) as unknown as StripeLike;
const realVerify: StripeFactory = () => sdk as never;

async function ws(id: string) {
  await prisma.$executeRaw`DELETE FROM workspaces WHERE id = ${id}`;
  await prisma.$executeRaw`INSERT INTO workspaces (id, name, owner_user_id, updated_at) VALUES (${id}, ${id}, ${"test:" + id}, now())`;
}

async function create(actor: OpsActor, slug: string, body: Record<string, unknown>) {
  const r = await withWorkspaceScope(actor.workspaceId, (tx) => opsCreate(tx, def(slug), actor, body));
  assert.equal(r.outcome, "done");
  return (r as { row: Record<string, unknown> }).row;
}

function event(id: string, type: string, object: Record<string, unknown>) {
  const payload = JSON.stringify({ id, object: "event", type, data: { object } });
  return { payload, header: sdk.webhooks.generateTestHeaderString({ payload, secret: WHSEC }) };
}

const ids = { mug: "", tee: "", teeL: "", teeS: "", svc: "", bProduct: "", storeA: "", storeB: "", bin: "", promo: "" };
let storeA: PublicStore;

before(async () => {
  await ws(WS_A);
  await ws(WS_B);
  // Workspace A catalogue: a tracked mug (10 on hand, pre-ledger), a tee with
  // two variants (6 L restocked into a bin), an untracked service.
  ids.mug = String((await create(A, "products", { name: "Mug", sku: "P10S-MUG", priceCents: 1500, stockQty: 10 })).id);
  ids.tee = String((await create(A, "products", { name: "Tee", sku: "P10S-TEE", priceCents: 2000 })).id);
  ids.teeL = String((await create(A, "product-variants", { productId: ids.tee, sku: "P10S-TEE-L", name: "Large", attributes: { size: "L" } })).id);
  ids.teeS = String((await create(A, "product-variants", { productId: ids.tee, sku: "P10S-TEE-S", name: "Small", attributes: { size: "S" }, priceCents: 1800 })).id);
  const wh = await create(A, "warehouses", { name: "Main", code: "P10S-WH" });
  ids.bin = String((await create(A, "locations", { warehouseId: wh.id, kind: "bin", code: "B-01" })).id);
  await create(A, "inventory-txns", { productId: ids.tee, variantId: ids.teeL, delta: 6, reason: "restock", locationId: ids.bin });
  ids.svc = String((await create(A, "products", { name: "Setup call", sku: "P10S-SVC", priceCents: 5000, trackInventory: false })).id);
  ids.promo = String((await create(A, "promotions", { code: "SAVE10", rules: { percentOff: 10 }, usageLimit: 1 })).id);

  ids.storeA = String((await create(A, "stores", { name: "Acme shop", slug: "p10store-acme", published: true, warehouseId: wh.id })).id);
  for (const [productId, pos] of [[ids.mug, 1], [ids.tee, 2], [ids.svc, 3]] as const) {
    await create(A, "store-listings", { storeId: ids.storeA, productId, position: pos });
  }
  await withWorkspaceScope(WS_A, (tx) => saveFinanceSettings(tx, A, { stripeSecretKey: SECRET_KEY, stripeWebhookSecret: WHSEC }));

  // Workspace B: its own published store with its own product, no Stripe.
  ids.bProduct = String((await create(B, "products", { name: "B lamp", sku: "P10S-LAMP", priceCents: 9900, stockQty: 3 })).id);
  ids.storeB = String((await create(B, "stores", { name: "B shop", slug: "p10store-bee", published: true })).id);
  await create(B, "store-listings", { storeId: ids.storeB, productId: ids.bProduct });

  storeA = (await resolvePublishedStore("p10store-acme"))!;
  assert.ok(storeA);
});

after(async () => {
  await prisma.$executeRaw`DELETE FROM workspaces WHERE id = ${WS_A}`;
  await prisma.$executeRaw`DELETE FROM workspaces WHERE id = ${WS_B}`;
  await prisma.$disconnect();
});

const order = (id: string) => withWorkspaceScope(WS_A, (tx) => tx.opsOrder.findFirstOrThrow({ where: { id } }));
const product = (id: string) => withWorkspaceScope(WS_A, (tx) => tx.opsProduct.findFirstOrThrow({ where: { id } }));

function cartWith(lines: Array<[string, string | null, number]>, promo?: string): Cart {
  let c = emptyCart(storeA.id);
  for (const [p, v, q] of lines) c = addToCart(c, p, v, q);
  return promo ? setCartPromo(c, promo) : c;
}

describe("storefront visibility (published only, RLS)", () => {
  it("only published stores resolve; unpublished → null; no GUC → nothing", async () => {
    assert.equal((await resolvePublishedStore("p10store-bee"))?.workspaceId, WS_B);
    await withWorkspaceScope(WS_B, (tx) => opsPatch(tx, def("stores"), B, { id: ids.storeB, published: false }));
    assert.equal(await resolvePublishedStore("p10store-bee"), null, "unpublished store 404s");
    assert.equal(await resolvePublishedStore("no-such-store"), null);
    assert.equal(await resolvePublishedStore("Bad Slug!"), null);
    assert.equal(await prisma.opsStore.count(), 0, "no GUC: RLS hides every store");
    await withWorkspaceScope(WS_B, (tx) => opsPatch(tx, def("stores"), B, { id: ids.storeB, published: true }));
  });

  it("lists active listed products with stock from the inventory totals", async () => {
    const listings = await loadPublicListings(storeA);
    assert.deepEqual(listings.map((l) => l.title), ["Mug", "Tee", "Setup call"]);
    const tee = listings[1]!;
    assert.deepEqual(tee.variants.map((v) => [v.name, v.priceCents, v.available]), [["Large", 2000, 6], ["Small", 1800, 0]]);
    assert.equal(listings[0]!.available, 10, "pre-ledger stock stays on the default variant");
    assert.equal(listings[2]!.available, null, "untracked service");
    // Deactivating the product hides it; unlisting hides it.
    await withWorkspaceScope(WS_A, (tx) => opsPatch(tx, def("products"), A, { id: ids.svc, active: false }));
    assert.equal(await loadPublicListing(storeA, listings[2]!.slug), null);
    await withWorkspaceScope(WS_A, (tx) => opsPatch(tx, def("products"), A, { id: ids.svc, active: true }));
  });

  it("store A can't list or sell store B's products", async () => {
    await assert.rejects(
      withWorkspaceScope(WS_A, (tx) => opsCreate(tx, def("store-listings"), A, { storeId: ids.storeA, productId: ids.bProduct })),
      (e: unknown) => e instanceof OpsError && e.status === 404,
    );
    const bListing = (await withWorkspaceScope(WS_B, (tx) => tx.opsStoreListing.findFirstOrThrow({ where: { productId: ids.bProduct } }))).slug;
    assert.equal(await loadPublicListing(storeA, bListing), null);
    const cart = cartWith([[ids.bProduct, null, 1]]);
    const catalog = await withWorkspaceScope(WS_A, (tx) => catalogForCart(tx, storeA, cart));
    assert.equal(catalog.size, 0);
    await assert.rejects(createStoreCheckout(storeA, cart, { baseUrl: "https://shop.test", stripe: stubStripe }), (e: unknown) => e instanceof OpsError && e.status === 409 && /no longer available/.test(e.message));
  });
});

describe("checkout", () => {
  it("without the tenant's Stripe key: refused, nothing created", async () => {
    const storeB = (await resolvePublishedStore("p10store-bee"))!;
    let c = emptyCart(storeB.id);
    c = addToCart(c, ids.bProduct, null, 1);
    const before = await withWorkspaceScope(WS_B, (tx) => tx.opsOrder.count());
    await assert.rejects(createStoreCheckout(storeB, c, { baseUrl: "https://shop.test", stripe: stubStripe }), StoreNotConnectedError);
    assert.equal(await withWorkspaceScope(WS_B, (tx) => tx.opsOrder.count()), before);
  });

  it("re-prices from the database and refuses short stock", async () => {
    const cart = cartWith([[ids.mug, null, 2]]);
    // The price changes after the cart was built: the database wins.
    await withWorkspaceScope(WS_A, (tx) => opsPatch(tx, def("products"), A, { id: ids.mug, priceCents: 1600 }));
    const { priced } = await withWorkspaceScope(WS_A, (tx) => priceCartFor(tx, storeA, cart));
    assert.equal(priced.subtotalCents, 3200);
    await withWorkspaceScope(WS_A, (tx) => opsPatch(tx, def("products"), A, { id: ids.mug, priceCents: 1500 }));
    await assert.rejects(
      createStoreCheckout(storeA, cartWith([[ids.tee, ids.teeS, 1]]), { baseUrl: "https://shop.test", stripe: stubStripe }),
      (e: unknown) => e instanceof OpsError && e.status === 409 && /out of stock/.test(e.message),
    );
  });
});

describe("paid webhook: order + payment + stock + journal, once", () => {
  let orderId = "";
  let sessionId = "";

  it("checkout creates a draft web order and a session for exactly its total", async () => {
    const cart = cartWith([[ids.mug, null, 2], [ids.tee, ids.teeL, 1], [ids.svc, null, 1]], "save10");
    const out = await createStoreCheckout(storeA, cart, { baseUrl: "https://shop.test/", stripe: stubStripe });
    orderId = out.orderId;
    sessionId = out.sessionId;
    const o = await order(orderId);
    // 2×1500 + 2000 + 5000 = 10000; 10% off → 9000
    assert.deepEqual([o.status, o.source, o.subtotalCents, o.discountCents, o.taxCents, o.totalCents], ["draft", "web", 10_000, 1000, 0, 9000]);
    assert.equal(o.promotionId, ids.promo);
    assert.equal(o.stripeSessionId, sessionId);
    const params = created.at(-1)!;
    assert.deepEqual(params.metadata, { workspace_id: WS_A, order_id: orderId, store_id: ids.storeA });
    assert.equal(params.success_url, "https://shop.test/shop/p10store-acme/thanks?session_id={CHECKOUT_SESSION_ID}");
    const lines = params.line_items as Array<{ quantity: number; price_data: { unit_amount: number } }>;
    assert.equal(lines.reduce((s, l) => s + l.quantity * l.price_data.unit_amount, 0), 9000);
  });

  it("one signed completed event confirms the order and books everything", async () => {
    const session = { id: sessionId, object: "checkout.session", payment_status: "paid", amount_total: 9000, payment_intent: "pi_p10store_1", customer_details: { email: "buyer@example.com", name: "Bea Buyer" }, metadata: { workspace_id: WS_A, order_id: orderId, store_id: ids.storeA } };
    const evt = event("evt_p10store_1", "checkout.session.completed", session);
    const bad = await handleStripeWebhook(WS_A, evt.payload, `${evt.header}x`, { stripe: realVerify });
    assert.equal(bad.status, 400);
    const ok = await handleStripeWebhook(WS_A, evt.payload, evt.header, { stripe: realVerify });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.status, "confirmed");

    const o = await order(orderId);
    assert.equal(o.status, "confirmed");
    assert.ok(o.paidAt);
    assert.equal(o.customerEmail, "buyer@example.com");
    const pays = await withWorkspaceScope(WS_A, (tx) => tx.opsPayment.findMany({ where: { orderId } }));
    assert.deepEqual(pays.map((p) => [p.provider, p.providerRef, p.amountCents, p.status, p.kind]), [["stripe", "pi_p10store_1", 9000, "succeeded", "charge"]]);
    assert.equal((await product(ids.mug)).stockQty, 8);
    assert.equal((await product(ids.tee)).stockQty, 5);
    const sales = await withWorkspaceScope(WS_A, (tx) => tx.opsInventoryTxn.findMany({ where: { reason: "sale" }, orderBy: { createdAt: "asc" } }));
    assert.deepEqual(sales.map((t) => [t.productId, t.variantId, t.delta]).sort(), [[ids.mug, `pvd_${ids.mug}`, -2], [ids.tee, ids.teeL, -1]].sort());
    assert.equal(sales.find((t) => t.productId === ids.tee)!.locationId, ids.bin, "located stock is used first");
    const je = await withWorkspaceScope(WS_A, (tx) => findEntryBySource(tx, WS_A, `web_order:${orderId}:paid`));
    assert.ok(je);
    assert.equal(je!.totalCents, 9000);
    assert.equal(je!.lines.reduce((s, l) => s + l.debitCents - l.creditCents, 0), 0, "balanced");
    const promo = await withWorkspaceScope(WS_A, (tx) => tx.opsPromotion.findFirstOrThrow({ where: { id: ids.promo } }));
    assert.equal(promo.usedCount, 1);
  });

  it("redelivery — same event or a new event id for the same payment — changes nothing", async () => {
    const session = { id: sessionId, object: "checkout.session", payment_status: "paid", amount_total: 9000, payment_intent: "pi_p10store_1", metadata: { workspace_id: WS_A, order_id: orderId } };
    for (const evtId of ["evt_p10store_1", "evt_p10store_1b"]) {
      for (const type of ["checkout.session.completed", "checkout.session.async_payment_succeeded"]) {
        const evt = event(evtId, type, session);
        const r = await handleStripeWebhook(WS_A, evt.payload, evt.header, { stripe: realVerify });
        assert.equal(r.status, 200);
        assert.equal(r.body.duplicate, true);
      }
    }
    assert.equal((await withWorkspaceScope(WS_A, (tx) => tx.opsPayment.count({ where: { orderId } }))), 1);
    assert.equal((await product(ids.mug)).stockQty, 8);
    assert.equal((await withWorkspaceScope(WS_A, (tx) => tx.opsJournalEntry.count({ where: { sourceKey: `web_order:${orderId}:paid` } }))), 1);
    assert.equal((await withWorkspaceScope(WS_A, (tx) => tx.opsPromotion.findFirstOrThrow({ where: { id: ids.promo } }))).usedCount, 1);
    // A late "expired" for the paid session never cancels a paid order.
    const exp = event("evt_p10store_late", "checkout.session.expired", { id: sessionId, object: "checkout.session", metadata: { workspace_id: WS_A, order_id: orderId } });
    await handleStripeWebhook(WS_A, exp.payload, exp.header, { stripe: realVerify });
    assert.equal((await order(orderId)).status, "confirmed");
  });

  it("the used-up code now blocks checkout instead of silently charging more", async () => {
    await assert.rejects(
      createStoreCheckout(storeA, cartWith([[ids.mug, null, 1]], "SAVE10"), { baseUrl: "https://shop.test", stripe: stubStripe }),
      (e: unknown) => e instanceof OpsError && e.status === 409 && /usage limit/.test(e.message),
    );
  });

  it("web orders show in the store overview; their money fields can't be edited", async () => {
    const ov = await withWorkspaceScope(WS_A, (tx) => storeOverview(tx, WS_A));
    assert.equal(ov.store?.slug, "p10store-acme");
    assert.equal(ov.stripeConnected, true);
    assert.equal(ov.webOrders.confirmed, 1);
    assert.equal(ov.webOrders.paidCents30d, 9000);
    const draft = await createStoreCheckout(storeA, cartWith([[ids.mug, null, 1]]), { baseUrl: "https://shop.test", stripe: stubStripe });
    await assert.rejects(
      withWorkspaceScope(WS_A, (tx) => opsPatch(tx, def("orders"), A, { id: draft.orderId, taxCents: 1 })),
      (e: unknown) => e instanceof OpsError && e.status === 409,
    );
  });
});

describe("unapplied money and expiry", () => {
  it("an amount that doesn't match the order is flagged, not applied", async () => {
    const out = await createStoreCheckout(storeA, cartWith([[ids.mug, null, 1]]), { baseUrl: "https://shop.test", stripe: stubStripe });
    const evt = event("evt_p10store_mismatch", "checkout.session.completed", { id: out.sessionId, object: "checkout.session", payment_status: "paid", amount_total: 1, payment_intent: "pi_p10store_mm", metadata: { workspace_id: WS_A, order_id: out.orderId } });
    const r = await handleStripeWebhook(WS_A, evt.payload, evt.header, { stripe: realVerify });
    assert.equal(r.body.unapplied, true);
    assert.equal((await order(out.orderId)).status, "draft");
    const audit = await withWorkspaceScope(WS_A, (tx) => tx.opsAuditEvent.findFirst({ where: { entityId: out.orderId, action: "stripe_payment_unapplied" } }));
    assert.ok(audit);
  });

  it("an expired session cancels its unpaid draft", async () => {
    const out = await createStoreCheckout(storeA, cartWith([[ids.svc, null, 1]]), { baseUrl: "https://shop.test", stripe: stubStripe });
    const evt = event("evt_p10store_exp", "checkout.session.expired", { id: out.sessionId, object: "checkout.session", payment_status: "unpaid", metadata: { workspace_id: WS_A, order_id: out.orderId } });
    const r = await handleStripeWebhook(WS_A, evt.payload, evt.header, { stripe: realVerify });
    assert.equal(r.body.cancelled, true);
    assert.equal((await order(out.orderId)).status, "cancelled");
  });

  it("another workspace's webhook can't touch A's order", async () => {
    const out = await createStoreCheckout(storeA, cartWith([[ids.svc, null, 1]]), { baseUrl: "https://shop.test", stripe: stubStripe });
    const evt = event("evt_p10store_x", "checkout.session.completed", { id: out.sessionId, object: "checkout.session", payment_status: "paid", amount_total: 5000, payment_intent: "pi_p10store_x", metadata: { workspace_id: WS_A, order_id: out.orderId } });
    const r = await handleStripeWebhook(WS_B, evt.payload, evt.header, { stripe: realVerify });
    assert.equal(r.status, 503, "B has no webhook secret");
    assert.equal((await order(out.orderId)).status, "draft");
  });
});

describe("agent tools (ops_store_*)", () => {
  it("overview reads the store; list_product hides and re-shows a product", async () => {
    const ov = await withWorkspaceScope(WS_A, (tx) => storeOverviewCore(tx, A));
    assert.match(ov.summary, /published/);
    const hide = await withWorkspaceScope(WS_A, (tx) => storeListProductCore(tx, A, { productId: ids.svc, listed: "false" }));
    assert.match(hide.summary, /hidden/);
    assert.equal((await loadPublicListings(storeA)).some((l) => l.productId === ids.svc), false);
    await withWorkspaceScope(WS_A, (tx) => storeListProductCore(tx, A, { productId: ids.svc, title: "Setup call (1h)" }));
    assert.equal((await loadPublicListings(storeA)).find((l) => l.productId === ids.svc)?.title, "Setup call (1h)");
    await assert.rejects(withWorkspaceScope(WS_A, (tx) => storeListProductCore(tx, A, { productId: ids.bProduct })), (e: unknown) => e instanceof OpsError && e.status === 404);
  });
});

