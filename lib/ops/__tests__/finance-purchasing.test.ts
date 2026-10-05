// ShapesOS — Phase 10 (finance): purchasing unit tests (PURE).
// Partial-receipt maths and bill lines from a PO.
// Run: npx tsx --test lib/ops/__tests__/finance-purchasing.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyReceipt, billLinesFromPo, remainingQty, type PoLine } from "../finance/purchasing";
import { OpsError } from "../doctype";
import { OPS_ENTITY_MAP } from "../entities";
import { assertOpsPatchAllowed } from "../doctype";

const LINES: PoLine[] = [
  { productId: "p1", name: "Widget", sku: "W", qty: 10, priceCents: 500 },
  { name: "Freight", qty: 1, priceCents: 2_000 },
];

describe("partial receipts", () => {
  it("receives part of a line → partially_received; the rest → received", () => {
    const a = applyReceipt(LINES, [{ index: 0, qty: 4 }]);
    assert.equal(a.status, "partially_received");
    assert.equal(a.lines[0]!.receivedQty, 4);
    assert.equal(remainingQty(a.lines[0]!), 6);
    const b = applyReceipt(a.lines, [{ index: 0, qty: 6 }, { index: 1, qty: 1 }]);
    assert.equal(b.status, "received");
    assert.equal(LINES[0]!.receivedQty, undefined, "input lines are not mutated");
  });
  it("refuses over-receipt, duplicates, unknown lines and empty receipts", () => {
    assert.throws(() => applyReceipt(LINES, [{ index: 0, qty: 11 }]), (e: unknown) => e instanceof OpsError && e.status === 422);
    assert.throws(() => applyReceipt(LINES, [{ index: 0, qty: 1 }, { index: 0, qty: 1 }]), /twice/);
    assert.throws(() => applyReceipt(LINES, [{ index: 5, qty: 1 }]), /No line 5/);
    assert.throws(() => applyReceipt(LINES, [{ index: 0, qty: 0 }]), /at least 1/);
    assert.throws(() => applyReceipt(LINES, []), /at least one line/);
  });
});

describe("bill lines from a purchase order", () => {
  it("bills received quantities once anything was received", () => {
    const received = applyReceipt(LINES, [{ index: 0, qty: 4 }]).lines;
    assert.deepEqual(billLinesFromPo(received, "acc_cogs"), [{ description: "Widget (W)", qty: 4, priceCents: 500, accountId: "acc_cogs" }]);
  });
  it("bills the ordered quantities when nothing was received yet", () => {
    assert.deepEqual(billLinesFromPo(LINES).map((l) => l.qty), [10, 1]);
  });
});

describe("RFQ stage on purchase orders", () => {
  const def = OPS_ENTITY_MAP["purchase-orders"]!;
  it("rfq → rfq_sent → draft → sent; RFQs stay editable; partial receipts can be closed out", () => {
    assert.doesNotThrow(() => assertOpsPatchAllowed(def, { status: "rfq" }, { status: "rfq_sent" }));
    assert.doesNotThrow(() => assertOpsPatchAllowed(def, { status: "rfq_sent" }, { status: "draft", lineItems: [] }));
    assert.doesNotThrow(() => assertOpsPatchAllowed(def, { status: "partially_received" }, { status: "received" }));
    assert.throws(() => assertOpsPatchAllowed(def, { status: "rfq" }, { status: "sent" }), /cannot move/);
    assert.throws(() => assertOpsPatchAllowed(def, { status: "sent" }, { lineItems: [] }), /only be edited/);
  });
});
