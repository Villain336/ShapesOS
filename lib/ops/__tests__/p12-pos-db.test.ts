// ShapesOS Phase 12 (mfgpos): point of sale on real Postgres, as the
// least-privilege app role — one open session per register, till sales
// priced server-side with promotions and tax, stock through the ledger, the
// offline queue's replay is a no-op (client order id), card references are
// single-use, the cash count, and the gated close posting ONE balanced
// entry; FORCE RLS on the new tables; the receipt renders as a PDF.
//   DATABASE_URL=<app role url> npx tsx --test lib/ops/__tests__/p12-pos-db.test.ts

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { OPS_ENTITY_MAP } from "../entities";
import { OpsError, opsCreate, opsPatch, type OpsActor } from "../doctype";
import { opsBindingFor } from "../gate";
import { quoteSale, recordPosSale, receiptDoc, sessionSummary, type PosSaleInput } from "../pos/service";
import { newClientOrderId } from "../pos/rules";
import { renderFinancePdf } from "../finance/pdf";
import { __setOpsToolsTestGatePort } from "@/lib/chat/ops-tools";
import { closePosSessionCore, posOverviewCore } from "@/lib/chat/ops-mfgpos-tools";

const WS = "p12pos-ws-a";
const WS_B = "p12pos-ws-b";
const A: OpsActor = { workspaceId: WS, userId: "user-p12pos" };
const def = (slug: string) => OPS_ENTITY_MAP[slug]!;
const inA = <T>(fn: Parameters<typeof withWorkspaceScope<T>>[1]) => withWorkspaceScope(WS, fn);
const rowOf = (r: unknown) => (r as { row: Record<string, unknown> }).row;
const pendingPort = { propose: async () => ({ id: "appr_p", status: "pending", riskTier: "medium" }), getApproval: async () => { throw new Error("unused"); } };

async function create(slug: string, body: Record<string, unknown>) {
  const r = await inA((tx) => opsCreate(tx, def(slug), A, body));
  assert.equal(r.outcome, "done");
  return rowOf(r);
}

async function approved(slug: string, binding: Parameters<typeof opsBindingFor>[0]): Promise<string> {
  const row = await inA((tx) =>
    tx.composioActionApproval.create({
      data: { workspaceId: WS, appKey: "ops", toolName: slug, riskTier: "medium", proposedArgs: opsBindingFor(binding) as object, plainSummary: "test", status: "approved", expiresAt: new Date(Date.now() + 3600_000) },
    }),
  );
  return row.id;
}

const sell = (sessionId: string, input: PosSaleInput) => inA((tx) => recordPosSale(tx, A, sessionId, input));
const stockOf = (productId: string) => inA((tx) => tx.opsProduct.findFirstOrThrow({ where: { id: productId } })).then((p) => p.stockQty);

let mug = "";
let shelf = "";
let register = "";
let session = "";
let firstOrder = "";
const cashSaleId = newClientOrderId();

before(async () => {
  for (const id of [WS, WS_B]) {
    await prisma.$executeRaw`DELETE FROM workspaces WHERE id = ${id}`;
    await prisma.$executeRaw`INSERT INTO workspaces (id, name, owner_user_id, updated_at) VALUES (${id}, ${id}, ${"test:" + id}, now())`;
  }
  mug = String((await create("products", { name: "Mug", sku: "MUG", priceCents: 1000 })).id);
  const wh = await create("warehouses", { name: "Shop", code: "SHOP" });
  shelf = String((await create("locations", { warehouseId: wh.id, kind: "zone", code: "FRONT" })).id);
  await create("inventory-txns", { productId: mug, delta: 10, reason: "restock", locationId: shelf });
  const tax = await create("tax-rates", { name: "Sales tax 8%", rateBps: 800 });
  await create("promotions", { code: "TEN", rules: { percentOff: 10 } });
  register = String((await create("pos-registers", { name: "Front counter", locationId: shelf, taxRateId: tax.id })).id);
});

after(async () => {
  for (const id of [WS, WS_B]) await prisma.$executeRaw`DELETE FROM workspaces WHERE id = ${id}`;
  await prisma.$disconnect();
});

describe("p12 point of sale (real Postgres, app role)", () => {
  it("opens a numbered session with a float; one open session per register", async () => {
    const s = await create("pos-sessions", { registerId: register, openingCashCents: 10_000 });
    session = String(s.id);
    assert.equal(s.status, "open");
    assert.match(String(s.number), /^POS-\d{4}$/);
    await assert.rejects(inA((tx) => opsCreate(tx, def("pos-sessions"), A, { registerId: register, openingCashCents: 0 })), (e: unknown) => e instanceof OpsError && e.status === 409);
  });

  it("a cash sale is priced server-side (promotion, tax), takes stock from the register's shelf and gives change", async () => {
    const q = await inA((tx) => quoteSale(tx, A, session, [{ productId: mug, qty: 2 }], "TEN"));
    assert.deepEqual(
      { s: q.subtotalCents, d: q.discountCents, t: q.taxCents, total: q.totalCents, ok: q.promo?.ok, blocker: q.blocker },
      { s: 2000, d: 200, t: 144, total: 1944, ok: true, blocker: null },
      "the quote is what the sale will charge",
    );
    const bad = await inA((tx) => quoteSale(tx, A, session, [{ productId: mug, qty: 1 }], "NOPE"));
    assert.equal(bad.promo?.ok, false);
    assert.match(String(bad.blocker), /can't be used/);
    const r = await sell(session, {
      clientOrderId: cashSaleId,
      lines: [{ productId: mug, qty: 2 }],
      promoCode: "ten",
      payments: [{ method: "cash", amountCents: 1944, tenderedCents: 2000, provider: "cash" }],
    });
    // 2000 − 10% = 1800, + 8% tax = 144 → 1944.
    assert.equal(r.replayed, false);
    assert.equal(r.totalCents, 1944);
    assert.equal(r.changeCents, 56);
    firstOrder = r.orderId;
    const o = await inA((tx) => tx.opsOrder.findFirstOrThrow({ where: { id: r.orderId }, include: { payments: true } }));
    assert.equal(o.source, "pos");
    assert.equal(o.status, "fulfilled");
    assert.equal(o.posSessionId, session);
    assert.equal(o.discountCents, 200);
    assert.equal(o.taxCents, 144);
    assert.deepEqual(o.payments.map((p) => [p.provider, p.amountCents, p.status]), [["cash", 1944, "succeeded"]]);
    assert.equal(await stockOf(mug), 8);
    const moves = await inA((tx) => tx.opsInventoryTxn.findMany({ where: { productId: mug, reason: "sale" } }));
    assert.deepEqual(moves.map((m) => [m.delta, m.locationId]), [[-2, shelf]]);
    const promo = await inA((tx) => tx.opsPromotion.findFirstOrThrow({ where: { code: "TEN" } }));
    assert.equal(promo.usedCount, 1);
  });

  it("the offline queue's replay of the same client order id is a no-op", async () => {
    const again = await sell(session, {
      clientOrderId: cashSaleId,
      lines: [{ productId: mug, qty: 2 }],
      promoCode: "ten",
      payments: [{ method: "cash", amountCents: 1944, tenderedCents: 2000, provider: "cash" }],
    });
    assert.equal(again.replayed, true);
    assert.equal(again.orderId, firstOrder);
    assert.equal(await inA((tx) => tx.opsOrder.count({ where: { clientOrderId: cashSaleId } })), 1);
    assert.equal(await inA((tx) => tx.opsPayment.count({ where: { orderId: firstOrder } })), 1);
    assert.equal(await stockOf(mug), 8, "stock moved once");
    // Concurrent replays resolve to the one order too.
    const id = newClientOrderId();
    const input: PosSaleInput = { clientOrderId: id, lines: [{ productId: mug, qty: 1 }], payments: [{ method: "cash", amountCents: 1080, provider: "cash" }] };
    const [x, y] = await Promise.all([sell(session, input), sell(session, input)]);
    assert.equal(x.orderId, y.orderId);
    assert.equal([x.replayed, y.replayed].filter(Boolean).length, 1);
    assert.equal(await stockOf(mug), 7);
  });

  it("refuses short tenders, unknown products and reused card references", async () => {
    await assert.rejects(sell(session, { clientOrderId: newClientOrderId(), lines: [{ productId: mug, qty: 1 }], payments: [{ method: "cash", amountCents: 1000, provider: "cash" }] }), (e: unknown) => e instanceof OpsError && e.status === 400);
    await assert.rejects(sell(session, { clientOrderId: newClientOrderId(), lines: [{ productId: "nope", qty: 1 }], payments: [{ method: "cash", amountCents: 1080, provider: "cash" }] }), (e: unknown) => e instanceof OpsError && e.status === 409);
    const card = { method: "card" as const, amountCents: 1080, providerRef: "mock_pi_1080_00112233aabbccdd", provider: "stripe_terminal_mock" as const };
    const ok = await sell(session, { clientOrderId: newClientOrderId(), lines: [{ productId: mug, qty: 1 }], payments: [card] });
    assert.equal(ok.replayed, false);
    const pay = await inA((tx) => tx.opsPayment.findFirstOrThrow({ where: { orderId: ok.orderId } }));
    assert.equal(pay.provider, "stripe_terminal_mock");
    assert.match(String(pay.note), /MOCK/);
    await assert.rejects(sell(session, { clientOrderId: newClientOrderId(), lines: [{ productId: mug, qty: 1 }], payments: [card] }), (e: unknown) => e instanceof OpsError && e.status === 409);
  });

  it("counting the cash stops sales and records expected vs counted", async () => {
    const live = await inA((tx) => sessionSummary(tx, WS, session));
    assert.equal(live.totals.orderCount, 3);
    assert.equal(live.totals.cashSalesCents, 1944 + 1080);
    assert.equal(live.totals.cardSalesCents, 1080);
    assert.equal(live.expectedCashCents, 10_000 + 3024);
    const r = await inA((tx) => opsPatch(tx, def("pos-sessions"), A, { id: session, status: "closing", countedCashCents: 12_980 }));
    const s = rowOf(r);
    assert.equal(s.status, "closing");
    assert.equal(s.expectedCashCents, 13_024);
    assert.equal(s.cashDifferenceCents, -44);
    await assert.rejects(sell(session, { clientOrderId: newClientOrderId(), lines: [{ productId: mug, qty: 1 }], payments: [{ method: "cash", amountCents: 1080, provider: "cash" }] }), (e: unknown) => e instanceof OpsError && e.status === 409);
    await assert.rejects(inA((tx) => opsPatch(tx, def("pos-sessions"), A, { id: session, status: "closed" }, { gatePort: pendingPort })).then((x) => {
      assert.equal(x.outcome, "approval_required");
      throw new Error("proposed");
    }), /proposed/, "closing without an approval only proposes it");
    assert.equal((await inA((tx) => tx.opsPosSession.findFirstOrThrow({ where: { id: session } }))).status, "closing");
  });

  it("agent tools: the overview reads the count; closing only proposes", async () => {
    const ov = await inA((tx) => posOverviewCore(tx, A));
    assert.match(ov.summary, /0\.44 short/);
    __setOpsToolsTestGatePort({ propose: async () => ({ id: "appr_tool", status: "pending", riskTier: "high" }), getApproval: async () => { throw new Error("unused"); } });
    try {
      const r = await inA((tx) => closePosSessionCore(tx, A, { sessionId: session }));
      assert.equal((r.details as { approvalRequired: boolean }).approvalRequired, true);
    } finally {
      __setOpsToolsTestGatePort(null);
    }
    assert.equal((await inA((tx) => tx.opsPosSession.findFirstOrThrow({ where: { id: session } }))).status, "closing");
    assert.equal(await inA((tx) => tx.opsJournalEntry.count({ where: { sourceType: "pos_session" } })), 0);
  });

  it("the approved close posts ONE balanced entry: sales, tax, cash, card clearing, cash short", async () => {
    const approvalId = await approved("OPS_POS_SESSION_CLOSE", { entity: "pos-sessions", entityId: session, slug: "OPS_POS_SESSION_CLOSE", mutation: { id: session, status: "closed" } });
    const r = await inA((tx) => opsPatch(tx, def("pos-sessions"), A, { id: session, status: "closed", approvalId }));
    assert.equal(r.outcome, "done");
    const s = rowOf(r);
    assert.equal(s.status, "closed");
    assert.equal(s.orderCount, 3);
    assert.equal(s.netSalesCents, 1800 + 1000 + 1000);
    assert.equal(s.taxCents, 144 + 80 + 80);
    const entries = await inA((tx) => tx.opsJournalEntry.findMany({ where: { sourceType: "pos_session", sourceId: session }, include: { lines: { include: { account: true } } } }));
    assert.equal(entries.length, 1);
    const e = entries[0]!;
    assert.equal(e.sourceKey, `pos_session:${session}:close`);
    assert.equal(s.journalEntryId, e.id);
    const net = (key: string) => e.lines.filter((l) => l.account.systemKey === key).reduce((t, l) => t + l.debitCents - l.creditCents, 0);
    assert.equal(net("cash"), 3024 - 44);
    assert.equal(net("card_clearing"), 1080);
    assert.equal(net("cash_over_short"), 44);
    assert.equal(net("sales"), -3800);
    assert.equal(net("tax_payable"), -304);
    assert.equal(e.lines.reduce((t, l) => t + l.debitCents, 0), e.lines.reduce((t, l) => t + l.creditCents, 0));
    // Closed is terminal; the register can open its next session.
    await assert.rejects(inA((tx) => opsPatch(tx, def("pos-sessions"), A, { id: session, status: "open" })), (err: unknown) => err instanceof OpsError && err.status === 409);
    const next = await create("pos-sessions", { registerId: register, openingCashCents: 5000 });
    assert.notEqual(next.number, null);
    assert.notEqual(next.number, s.number);
  });

  it("the receipt renders as a PDF with the discount", async () => {
    const doc = await inA((tx) => receiptDoc(tx, WS, firstOrder));
    assert.equal(doc.kind, "Receipt");
    assert.equal(doc.subtotalCents, 2000);
    assert.equal(doc.discountCents, 200);
    assert.equal(doc.totalCents, 1944);
    const pdf = await renderFinancePdf(doc);
    assert.equal(pdf.subarray(0, 4).toString(), "%PDF");
  });

  it("RLS: workspace B sees none of A's registers or sessions; no GUC sees nothing", async () => {
    const counts = await withWorkspaceScope(WS_B, async (tx) => [
      await tx.opsPosRegister.count({ where: { workspaceId: WS } }),
      await tx.opsPosSession.count({ where: { workspaceId: WS } }),
    ]);
    assert.deepEqual(counts, [0, 0]);
    for (const t of ["ops_pos_registers", "ops_pos_sessions"]) {
      const n = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*)::bigint AS n FROM ${t}`);
      assert.equal(Number(n[0]!.n), 0, `${t}: FORCE RLS`);
    }
    await assert.rejects(withWorkspaceScope(WS_B, (tx) => tx.opsPosRegister.create({ data: { workspaceId: WS, name: "x" } })));
    await assert.rejects(
      withWorkspaceScope(WS_B, (tx) => recordPosSale(tx, { workspaceId: WS_B, userId: "b" }, session, { clientOrderId: newClientOrderId(), lines: [{ productId: mug, qty: 1 }], payments: [{ method: "cash", amountCents: 1080, provider: "cash" }] })),
      (e: unknown) => e instanceof OpsError && e.status === 404,
    );
  });
});
