// ShapesOS Phase 12 (mfgpos): point-of-sale rules (pure) — tender, session
// totals, the cash count, the session-close journal entry, the offline
// queue's idempotent replay, and the Stripe Terminal adapter (fake fetch +
// the labelled mock).
//   npx tsx --test lib/ops/__tests__/p12-pos.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CLIENT_ORDER_ID_RE,
  canMoveSession,
  cashDifferenceCents,
  describeDifference,
  expectedCashCents,
  newClientOrderId,
  sessionTotals,
  tender,
  TenderError,
} from "../pos/rules";
import { classifySend, enqueue, readQueue, replayQueue, type KeyValueStore, type QueuedSale, type SendResult } from "../pos/offline-queue";
import { mockTerminal, stripeTerminalRest, terminalAdapter, TerminalError } from "../pos/terminal";
import { assertBalanced, posSessionCloseLines, type DraftLine } from "../accounting/rules";
import { OPS_ENTITY_MAP } from "../entities";
import { classifyOpsWrite } from "../gate";

function memStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

const side = (lines: DraftLine[], key: string) =>
  lines.filter((l) => "key" in l.account && l.account.key === key).reduce((s, l) => s + l.debitCents - l.creditCents, 0);

describe("tender", () => {
  it("cash, card and split payments must equal the total; change comes from over-tendered cash", () => {
    assert.deepEqual(tender(1250, [{ method: "cash", amountCents: 1250, tenderedCents: 2000 }]), { cashCents: 1250, cardCents: 0, changeCents: 750 });
    assert.deepEqual(tender(1250, [{ method: "card", amountCents: 1250, providerRef: "pi_1" }]), { cashCents: 0, cardCents: 1250, changeCents: 0 });
    assert.deepEqual(tender(1000, [{ method: "cash", amountCents: 400 }, { method: "card", amountCents: 600, providerRef: "pi_2" }]), { cashCents: 400, cardCents: 600, changeCents: 0 });
  });
  it("refuses short, over, empty and malformed tenders", () => {
    assert.throws(() => tender(1000, [{ method: "cash", amountCents: 900 }]), TenderError);
    assert.throws(() => tender(1000, [{ method: "cash", amountCents: 1100 }]), TenderError, "over-payment is change, not takings");
    assert.throws(() => tender(1000, []), TenderError);
    assert.throws(() => tender(1000, [{ method: "cash", amountCents: 1000, tenderedCents: 500 }]), TenderError);
    assert.throws(() => tender(1000, [{ method: "card", amountCents: 1000, providerRef: "" }]), TenderError);
    assert.throws(() => tender(1000, [{ method: "cash", amountCents: 10.5 } as never, { method: "cash", amountCents: 989.5 } as never]), TenderError);
  });
});

describe("session totals and the cash count", () => {
  const orders = [
    { status: "fulfilled", totalCents: 1080, taxCents: 80, discountCents: 0 },
    { status: "fulfilled", totalCents: 540, taxCents: 40, discountCents: 100 },
    { status: "cancelled", totalCents: 999, taxCents: 0, discountCents: 0 },
  ];
  const payments = [
    { provider: "cash", kind: "charge", status: "succeeded", amountCents: 1080 },
    { provider: "stripe_terminal", kind: "charge", status: "succeeded", amountCents: 300 },
    { provider: "stripe_terminal_mock", kind: "charge", status: "succeeded", amountCents: 240 },
    { provider: "cash", kind: "charge", status: "failed", amountCents: 999 },
  ];
  it("sums net sales, tax, discounts, cash and card (cancelled and failed rows ignored)", () => {
    assert.deepEqual(sessionTotals(orders, payments), {
      orderCount: 2,
      netSalesCents: 1500,
      discountCents: 100,
      taxCents: 120,
      cashSalesCents: 1080,
      cardSalesCents: 540,
    });
  });
  it("expected = float + cash takings; difference = counted − expected", () => {
    const expected = expectedCashCents(10_000, 1080);
    assert.equal(expected, 11_080);
    assert.equal(cashDifferenceCents(11_080, expected), 0);
    assert.equal(cashDifferenceCents(11_000, expected), -80);
    assert.equal(cashDifferenceCents(11_230, expected), 150);
    assert.equal(describeDifference(-80), "$0.80 short");
    assert.equal(describeDifference(150), "$1.50 over");
    assert.equal(describeDifference(0), "exact");
  });
  it("session moves: open → closing → closed, closing ↔ open; closing is gated only on close", () => {
    assert.ok(canMoveSession("open", "closing"));
    assert.ok(canMoveSession("closing", "open"));
    assert.ok(canMoveSession("closing", "closed"));
    assert.ok(!canMoveSession("open", "closed"), "count the cash first");
    assert.ok(!canMoveSession("closed", "open"));
    assert.equal(classifyOpsWrite({ entity: "pos-sessions", op: "update", body: { id: "s", status: "closed" } }).slug, "OPS_POS_SESSION_CLOSE");
    assert.equal(classifyOpsWrite({ entity: "pos-sessions", op: "update", body: { id: "s", status: "closing", countedCashCents: 5 } }).mode, "free");
    assert.equal(classifyOpsWrite({ entity: "pos-sessions", op: "create", body: { registerId: "r", openingCashCents: 0 } }).mode, "free");
    assert.ok(OPS_ENTITY_MAP["pos-registers"]);
  });
});

describe("session-close journal entry", () => {
  const base = { netSalesCents: 1500, taxCents: 120, cashSalesCents: 1080, cardSalesCents: 540 };
  it("balances with an exact count: Dr cash + card clearing = Cr sales + tax", () => {
    const lines = posSessionCloseLines({ ...base, cashDifferenceCents: 0 }, "POS-0001");
    assert.equal(assertBalanced(lines), 1620);
    assert.equal(side(lines, "cash"), 1080);
    assert.equal(side(lines, "card_clearing"), 540);
    assert.equal(side(lines, "sales"), -1500);
    assert.equal(side(lines, "tax_payable"), -120);
    assert.equal(side(lines, "cash_over_short"), 0);
  });
  it("a shortage debits cash over/short, an overage credits it — always balanced", () => {
    const short = posSessionCloseLines({ ...base, cashDifferenceCents: -80 }, "x");
    assertBalanced(short);
    assert.equal(side(short, "cash"), 1000);
    assert.equal(side(short, "cash_over_short"), 80);
    const over = posSessionCloseLines({ ...base, cashDifferenceCents: 150 }, "x");
    assertBalanced(over);
    assert.equal(side(over, "cash"), 1230);
    assert.equal(side(over, "cash_over_short"), -150);
  });
  it("a shortage bigger than the cash takings credits cash (card-only day, float short)", () => {
    const lines = posSessionCloseLines({ netSalesCents: 500, taxCents: 0, cashSalesCents: 0, cardSalesCents: 500, cashDifferenceCents: -200 }, "x");
    assertBalanced(lines);
    assert.equal(side(lines, "cash"), -200);
    assert.equal(side(lines, "cash_over_short"), 200);
  });
  it("posts tax to the register rate's own account when it has one", () => {
    const lines = posSessionCloseLines({ ...base, cashDifferenceCents: 0 }, "x", { id: "acc_tax_ca" });
    assert.ok(lines.some((l) => "id" in l.account && l.account.id === "acc_tax_ca" && l.creditCents === 120));
  });
});

describe("offline queue", () => {
  const sale = (id: string): Omit<QueuedSale, "queuedAt" | "attempts"> => ({ clientOrderId: id, sessionId: "s1", body: { clientOrderId: id } });

  it("enqueue is idempotent per client order id", () => {
    const store = memStore();
    enqueue(store, sale("pos_a_1"));
    enqueue(store, sale("pos_a_1"));
    enqueue(store, sale("pos_a_2"));
    assert.deepEqual(readQueue(store, "s1").map((s) => s.clientOrderId), ["pos_a_1", "pos_a_2"]);
  });

  it("replays in order; a sale the server already has comes back as a replay, not a second sale", async () => {
    const store = memStore();
    for (const id of ["pos_a_1", "pos_a_2", "pos_a_3"]) enqueue(store, sale(id));
    // The fake server keys on the client order id exactly like ops_orders'
    // (workspace_id, client_order_id) unique key.
    const server = new Map<string, string>([["pos_a_1", "ord_1"]]); // landed before the connection dropped
    let created = 0;
    const send = async (s: QueuedSale): Promise<SendResult> => {
      const prior = server.get(s.clientOrderId);
      if (prior) return { ok: true, replayed: true, orderId: prior };
      created += 1;
      server.set(s.clientOrderId, `ord_new_${created}`);
      return { ok: true, replayed: false, orderId: `ord_new_${created}` };
    };
    const r1 = await replayQueue(store, "s1", send);
    assert.deepEqual(r1.sent.map((s) => [s.clientOrderId, s.replayed]), [["pos_a_1", true], ["pos_a_2", false], ["pos_a_3", false]]);
    assert.equal(r1.remaining, 0);
    // Replaying again (e.g. a second tab) sells nothing new.
    for (const id of ["pos_a_2", "pos_a_3"]) enqueue(store, sale(id));
    const r2 = await replayQueue(store, "s1", send);
    assert.ok(r2.sent.every((s) => s.replayed));
    assert.equal(created, 2, "three queued sales, one already on the server → exactly two new orders");
    assert.equal(server.size, 3);
  });

  it("a network failure stops the replay and keeps the rest; a permanent refusal is reported and dropped", async () => {
    const store = memStore();
    for (const id of ["pos_b_1", "pos_b_2", "pos_b_3"]) enqueue(store, sale(id));
    const r = await replayQueue(store, "s1", async (s) =>
      s.clientOrderId === "pos_b_1" ? { ok: false, permanent: true, error: "Session POS-0001 is closed" } : { ok: false, permanent: false, error: "No connection" },
    );
    assert.deepEqual(r.failed, [{ clientOrderId: "pos_b_1", error: "Session POS-0001 is closed" }]);
    assert.equal(r.remaining, 2);
    const q = readQueue(store, "s1");
    assert.equal(q[0]!.clientOrderId, "pos_b_2");
    assert.equal(q[0]!.attempts, 1);
    assert.equal(q[0]!.lastError, "No connection");
  });

  it("classifies responses: 2xx with an order id = sent, 4xx = permanent, network/5xx/429 = retry", () => {
    assert.deepEqual(classifySend(201, { orderId: "o", replayed: false }), { ok: true, replayed: false, orderId: "o" });
    assert.deepEqual(classifySend(200, { orderId: "o", replayed: true }), { ok: true, replayed: true, orderId: "o" });
    assert.equal((classifySend(409, { error: "closed" }) as { permanent: boolean }).permanent, true);
    assert.equal((classifySend(500, null) as { permanent: boolean }).permanent, false);
    assert.equal((classifySend(429, null) as { permanent: boolean }).permanent, false);
    assert.equal((classifySend(null, null) as { permanent: boolean }).permanent, false);
  });

  it("client order ids are unique and match the server's format", () => {
    const ids = new Set(Array.from({ length: 200 }, () => newClientOrderId()));
    assert.equal(ids.size, 200);
    for (const id of ids) assert.match(id, CLIENT_ORDER_ID_RE);
  });
});

describe("Stripe Terminal adapter (UNVERIFIED-LIVE: fake fetch)", () => {
  it("creates a card_present intent, hands it to the reader, captures if needed", async () => {
    const calls: Array<{ method: string; url: string; body?: string; headers: Record<string, string> }> = [];
    const fake = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
      calls.push({ url, ...init });
      const body =
        url.endsWith("/payment_intents") ? { id: "pi_123", status: "requires_payment_method", amount: 1620, currency: "usd" }
        : url.includes("/process_payment_intent") ? { id: "tmr_X", action: { status: "in_progress" } }
        : url.endsWith("/capture") ? { id: "pi_123", status: "succeeded", amount: 1620, currency: "usd" }
        : { id: "pi_123", status: "requires_capture", amount: 1620, currency: "usd" };
      return { ok: true, status: 200, json: async () => body };
    };
    const t = stripeTerminalRest("sk_test_abc12345", fake);
    assert.equal(t.provider, "stripe_terminal");
    const p = await t.startPayment({ amountCents: 1620, currency: "USD", readerId: "tmr_X", idempotencyKey: "pos_k_1", metadata: { session_id: "s1" } });
    assert.equal(p.id, "pi_123");
    assert.match(calls[0]!.body!, /payment_method_types%5B%5D=card_present/);
    assert.match(calls[0]!.body!, /amount=1620/);
    assert.match(calls[0]!.body!, /metadata%5Bsession_id%5D=s1/);
    assert.equal(calls[0]!.headers.authorization, "Bearer sk_test_abc12345");
    assert.equal(calls[0]!.headers["idempotency-key"], "pos-pi-pos_k_1");
    assert.match(calls[1]!.url, /\/terminal\/readers\/tmr_X\/process_payment_intent$/);
    const done = await t.getPayment("pi_123");
    assert.equal(done.status, "succeeded");
    assert.ok(calls.some((c) => c.url.endsWith("/payment_intents/pi_123/capture")));
    await assert.rejects(t.startPayment({ amountCents: 1, currency: "usd", readerId: null, idempotencyKey: "k", metadata: {} }), (e: unknown) => e instanceof TerminalError && e.status === 409);
    await assert.rejects(t.getPayment("not-a-pi"), TerminalError);
  });

  it("surfaces Stripe errors", async () => {
    const t = stripeTerminalRest("sk_test_abc12345", async () => ({ ok: false, status: 402, json: async () => ({ error: { message: "Your card was declined." } }) }));
    await assert.rejects(t.getPayment("pi_1"), (e: unknown) => e instanceof TerminalError && e.message === "Your card was declined." && e.status === 402);
  });

  it("the MOCK is opt-in (POS_TERMINAL_MOCK=1), labelled, and carries its amount in the id", async () => {
    assert.equal(terminalAdapter(null, {}), null, "no key, no mock → card unavailable");
    assert.equal(terminalAdapter("sk_test_abc12345", {})?.mode, "live");
    const m = terminalAdapter(null, { POS_TERMINAL_MOCK: "1" })!;
    assert.equal(m.mode, "mock");
    assert.equal(m.provider, "stripe_terminal_mock");
    const p = await mockTerminal().startPayment({ amountCents: 777, currency: "usd", readerId: null, idempotencyKey: "k", metadata: {} });
    assert.match(p.id, /^mock_pi_777_[0-9a-f]{16}$/);
    assert.deepEqual(await mockTerminal().getPayment(p.id), { id: p.id, status: "succeeded", amountCents: 777, currency: "usd" });
    await assert.rejects(mockTerminal().getPayment("pi_real"), TerminalError, "the mock never vouches for a real reference");
  });
});
