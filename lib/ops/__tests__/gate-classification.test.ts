// Marketr — Phase 17 slice 1 tests: ops gate classification.
// Run: npx tsx --test lib/ops/__tests__/gate-classification.test.ts
//
// Pins the locked doctrine as fixtures:
//   - reads + draft-creators run freely (logged)
//   - sends / charges / refunds / deletes are gated writes
//   - money-moving = medium gate MINIMUM, bulk refunds = high gate
//   - the Phase 14 classifier must meet or exceed every ops pin
//     (catalog-drift style: a weakened derivation fails the build instead
//     of silently gating wrong)
//
// Pure: no database. assertPhase14TierMeetsPin() exercises the REAL Phase 14
// classifyAction against the pins.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  OPS_MONEY_ACTIONS,
  OPS_MONEY_ACTION_MAP,
  assertPhase14TierMeetsPin,
  classifyOpsWrite,
  type RiskTier,
} from "../gate";

const RANK: Record<RiskTier, number> = { low: 0, medium: 1, high: 2 };

describe("ops gate classification", () => {
  it("pins 25 money actions with medium-minimum tiers (bulk refund and payroll approval high)", () => {
    // 12 + Phase 10 (finance): journal post/reverse, credit note, quote send,
    // bill pay, expense approve/reimburse + Phase 12 (mfgpos): MO confirm /
    // complete, scrap, till session close + Phase 12 (people): payroll
    // approve (high) and post.
    assert.equal(OPS_MONEY_ACTIONS.length, 25);
    const pins: Record<string, RiskTier> = {
      OPS_INVOICE_SEND: "medium",
      OPS_INVOICE_MARK_PAID: "medium",
      // Slice 2: outbound payment reminders are money comms.
      OPS_INVOICE_REMIND: "medium",
      OPS_PAYMENT_RECORD_CHARGE: "medium",
      OPS_PAYMENT_REFUND: "medium",
      OPS_PAYMENT_BULK_REFUND: "high",
      OPS_ORDER_CANCEL: "medium",
      OPS_ORDER_FULFILL: "medium",
      // Slice 3: sending a purchase order is a money commitment.
      OPS_PO_SEND: "medium",
      // Slice 5: approving a leave request is a manager decision — gated
      // like other ops approvals.
      OPS_LEAVE_APPROVE: "medium",
      // Slice 6: running a money-moving operations workflow (the single
      // pre-authorized approval covers the step plan + rollback plan).
      OPS_WORKFLOW_RUN: "medium",
      OPS_RECORD_DELETE: "medium",
      // Phase 10 (finance)
      OPS_JOURNAL_POST: "medium",
      OPS_JOURNAL_REVERSE: "medium",
      OPS_CREDIT_NOTE_ISSUE: "medium",
      OPS_QUOTE_SEND: "medium",
      OPS_BILL_PAY: "medium",
      OPS_EXPENSE_APPROVE: "medium",
      OPS_EXPENSE_REIMBURSE: "medium",
      // Phase 12 (mfgpos)
      OPS_MO_CONFIRM: "medium",
      OPS_MO_COMPLETE: "medium",
      OPS_SCRAP_POST: "medium",
      OPS_POS_SESSION_CLOSE: "medium",
      // Phase 12 (people)
      OPS_PAYROLL_APPROVE: "high",
      OPS_PAYROLL_POST: "medium",
    };
    for (const [slug, tier] of Object.entries(pins)) {
      assert.equal(OPS_MONEY_ACTION_MAP[slug]?.expectedTier, tier, slug);
    }
    // No money action is pinned below medium — the locked minimum.
    for (const a of OPS_MONEY_ACTIONS) {
      assert.ok(RANK[a.expectedTier] >= RANK.medium, `${a.slug} >= medium`);
    }
  });

  it("Phase 14 derivation meets or exceeds every ops pin (no drift)", () => {
    const rows = assertPhase14TierMeetsPin();
    assert.equal(rows.length, 25); // 12 + 7 Phase 10 (finance) + 4 Phase 12 (mfgpos) + 2 Phase 12 (people)
    for (const r of rows) {
      assert.ok(
        RANK[r.derived] >= RANK[r.expected],
        `${r.slug}: derived ${r.derived} must meet pin ${r.expected}`,
      );
    }
    // Spot-check the load-bearing derivations.
    const bySlug = Object.fromEntries(rows.map((r) => [r.slug, r.derived]));
    assert.equal(bySlug["OPS_INVOICE_SEND"], "medium", "SEND is a write verb");
    assert.equal(bySlug["OPS_PAYMENT_BULK_REFUND"], "high", "unclassified refund floors to high");
    assert.equal(bySlug["OPS_RECORD_DELETE"], "high", "DELETE is destructive");
  });

  it("draft-creators run freely (logged): every non-payment create is free", () => {
    const freeCreates: Array<[string, Record<string, unknown>]> = [
      ["products", { name: "X", sku: "X", priceCents: 1 }],
      ["orders", { lineItems: [] }],
      ["promotions", { code: "X" }],
      ["invoices", { lineItems: [] }],
      // Slice 3: PO drafts are free logged writes; send is the gated money step.
      ["purchase-orders", { lineItems: [] }],
      ["inventory-txns", { productId: "p", delta: 1, reason: "restock" }],
      ["projects", { name: "X" }],
      ["workflow-runs", { workflowName: "w" }],
    ];
    for (const [entity, body] of freeCreates) {
      const c = classifyOpsWrite({ entity, op: "create", body });
      assert.equal(c.mode, "free", `${entity} create`);
      assert.equal(c.tier, "low");
      assert.ok(/freely/.test(c.reason), `${entity}: reason says freely`);
    }
  });

  it("every payment create is a gated write (money records, never drafts)", () => {
    const charge = classifyOpsWrite({ entity: "payments", op: "create", body: { kind: "charge", amountCents: 100 } });
    assert.equal(charge.mode, "gated");
    assert.equal(charge.slug, "OPS_PAYMENT_RECORD_CHARGE");
    assert.equal(charge.tier, "medium");

    const refund = classifyOpsWrite({ entity: "payments", op: "create", body: { kind: "refund", amountCents: 100 } });
    assert.equal(refund.mode, "gated");
    assert.equal(refund.slug, "OPS_PAYMENT_REFUND");
    assert.equal(refund.tier, "medium");

    const bulk = classifyOpsWrite({
      entity: "payments", op: "create",
      body: { kind: "refund", items: [{ amountCents: 100 }, { amountCents: 200 }] },
    });
    assert.equal(bulk.mode, "gated");
    assert.equal(bulk.slug, "OPS_PAYMENT_BULK_REFUND");
    assert.equal(bulk.tier, "high", "bulk refunds are high-gated");
  });

  it("invoice money transitions are gated; plain updates are free", () => {
    const send = classifyOpsWrite({ entity: "invoices", op: "update", body: { status: "sent" } });
    assert.equal(send.mode, "gated");
    assert.equal(send.slug, "OPS_INVOICE_SEND");
    assert.equal(send.tier, "medium");

    const paid = classifyOpsWrite({ entity: "invoices", op: "update", body: { status: "paid" } });
    assert.equal(paid.slug, "OPS_INVOICE_MARK_PAID");

    const overdue = classifyOpsWrite({ entity: "invoices", op: "update", body: { status: "overdue" } });
    assert.equal(overdue.mode, "free", "overdue is derived bookkeeping, not money movement");

    const rename = classifyOpsWrite({ entity: "invoices", op: "update", body: { customerId: "c1" } });
    assert.equal(rename.mode, "free");
  });

  it("order cancel/fulfill are gated; confirm is free", () => {
    assert.equal(classifyOpsWrite({ entity: "orders", op: "update", body: { status: "cancelled" } }).slug, "OPS_ORDER_CANCEL");
    assert.equal(classifyOpsWrite({ entity: "orders", op: "update", body: { status: "fulfilled" } }).slug, "OPS_ORDER_FULFILL");
    const confirm = classifyOpsWrite({ entity: "orders", op: "update", body: { status: "confirmed" } });
    assert.equal(confirm.mode, "free", "confirm is an internal state move");
  });

  it("deletes are gated writes on every entity", () => {
    for (const entity of ["products", "orders", "payments", "promotions", "invoices", "inventory-txns", "projects", "workflow-runs", "purchase-orders", "team-members", "leave-requests"]) {
      const c = classifyOpsWrite({ entity, op: "delete", body: {} });
      assert.equal(c.mode, "gated", `${entity} delete`);
      assert.equal(c.slug, "OPS_RECORD_DELETE");
      assert.ok(RANK[c.tier] >= RANK.medium);
    }
  });

  it("PO send/cancel are gated money moves; receive is free fulfillment", () => {
    const send = classifyOpsWrite({ entity: "purchase-orders", op: "update", body: { status: "sent" } });
    assert.equal(send.mode, "gated");
    assert.equal(send.slug, "OPS_PO_SEND");
    assert.equal(send.tier, "medium");

    const cancel = classifyOpsWrite({ entity: "purchase-orders", op: "update", body: { status: "cancelled" } });
    assert.equal(cancel.mode, "gated");
    assert.equal(cancel.slug, "OPS_RECORD_DELETE");

    const receive = classifyOpsWrite({ entity: "purchase-orders", op: "update", body: { status: "received" } });
    assert.equal(receive.mode, "free", "receive is fulfillment bookkeeping, not a money commitment");
  });

  it("unknown entity / unknown money action fail closed at classify time", () => {
    assert.throws(() => classifyOpsWrite({ entity: "nope", op: "create", body: {} }), /Unknown ops entity/);
  });
});
