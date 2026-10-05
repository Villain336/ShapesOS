// Phase 11 (conncore): which outbound webhook events an ops write produces
// (PURE mapping), and that every new type is in the catalog with a label.
// Run: npx tsx --test lib/webhooks/__tests__/ops-events.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { opsWebhookEvents, invoicePaidEvent, orderPaidEvent } from "../ops-events";
import { SUBSCRIBABLE_EVENT_TYPES, WEBHOOK_EVENT_LABELS, WEBHOOK_EVENT_SCHEMAS } from "../events";

const t = "2026-10-04T10:00:00.000Z";
const types = (evs: Array<{ type: string }>) => evs.map((e) => e.type);

describe("ops entity → webhook events", () => {
  it("covers the Phase 9/10 entities in the catalog (subscribable, labelled, schema-valid)", () => {
    for (const type of ["invoice.sent", "order.paid", "quote.sent", "quote.accepted", "deal.created", "deal.stage_changed", "deal.won", "deal.lost", "ticket.created", "ticket.solved", "contact.created"] as const) {
      assert.ok(type in WEBHOOK_EVENT_SCHEMAS, type);
      assert.ok(WEBHOOK_EVENT_LABELS[type], type);
      assert.ok(SUBSCRIBABLE_EVENT_TYPES.includes(type), type);
    }
  });

  it("invoices: sent and paid on the transition only; credit notes never", () => {
    const draft = { id: "inv1", status: "draft", totalCents: 1000, taxCents: 100, kind: "invoice" };
    const sent = { ...draft, status: "sent", number: "INV-1", sentAt: new Date(t), dueAt: null };
    const evs = opsWebhookEvents("invoices", draft, sent);
    assert.deepEqual(types(evs), ["invoice.sent"]);
    assert.equal(evs[0].dedupKey, "invoice.sent:inv1");
    assert.ok(WEBHOOK_EVENT_SCHEMAS["invoice.sent"].safeParse(evs[0].data).success);
    assert.deepEqual(opsWebhookEvents("invoices", sent, { ...sent, dueAt: new Date(t) }), [], "no transition → no event");
    assert.deepEqual(types(opsWebhookEvents("invoices", sent, { ...sent, status: "paid", updatedAt: new Date(t) })), ["invoice.paid"]);
    assert.deepEqual(opsWebhookEvents("invoices", null, { ...sent, kind: "credit_note", status: "paid" }), []);
    assert.equal(invoicePaidEvent({ ...sent, status: "paid" }).dedupKey, "invoice.paid:inv1");
  });

  it("deals: created, every stage move (with fromStage), won and lost", () => {
    const d = { id: "d1", title: "Big", pipelineId: "p1", stage: "new", status: "open", valueCents: 500, contactId: null, companyId: null, ownerId: "u1", expectedCloseAt: null, closedAt: null, updatedAt: new Date(t) };
    assert.deepEqual(types(opsWebhookEvents("deals", null, d)), ["deal.created"]);
    const moved = opsWebhookEvents("deals", d, { ...d, stage: "proposal" });
    assert.deepEqual(types(moved), ["deal.stage_changed"]);
    assert.equal((moved[0].data as { fromStage: string }).fromStage, "new");
    assert.equal(moved[0].dedupKey, null, "a stage can be re-entered");
    const won = opsWebhookEvents("deals", { ...d, stage: "proposal" }, { ...d, stage: "won", status: "won", closedAt: new Date(t) });
    assert.deepEqual(types(won), ["deal.stage_changed", "deal.won"]);
    assert.ok(WEBHOOK_EVENT_SCHEMAS["deal.won"].safeParse(won[1].data).success);
    assert.deepEqual(types(opsWebhookEvents("deals", d, { ...d, stage: "lost", status: "lost" })), ["deal.stage_changed", "deal.lost"]);
  });

  it("tickets, quotes, contacts and paid web orders", () => {
    const tk = { id: "t1", number: 7, subject: "Help", status: "new", priority: "high", channel: "email", requesterEmail: "a@x.com", contactId: null, assigneeId: null, createdAt: new Date(t), updatedAt: new Date(t) };
    assert.deepEqual(types(opsWebhookEvents("tickets", null, tk)), ["ticket.created"]);
    assert.deepEqual(types(opsWebhookEvents("tickets", tk, { ...tk, status: "solved" })), ["ticket.solved"]);
    assert.deepEqual(opsWebhookEvents("tickets", tk, { ...tk, status: "pending" }), []);
    const q = { id: "q1", number: "Q-1", customerId: null, totalCents: 900, status: "draft", validUntil: null };
    assert.deepEqual(types(opsWebhookEvents("quotes", q, { ...q, status: "sent" })), ["quote.sent"]);
    assert.deepEqual(types(opsWebhookEvents("quotes", { ...q, status: "sent" }, { ...q, status: "accepted" })), ["quote.accepted"]);
    assert.deepEqual(types(opsWebhookEvents("contacts", null, { id: "c1", name: "Ada", email: null, createdAt: new Date(t) })), ["contact.created"]);
    assert.deepEqual(opsWebhookEvents("contacts", { id: "c1" }, { id: "c1", name: "Ada" }), []);
    assert.deepEqual(opsWebhookEvents("products", null, { id: "p1" }), [], "other entities emit nothing");
    const op = orderPaidEvent({ id: "o1", source: "web", storeId: "s1", totalCents: 1200, taxCents: 0, status: "confirmed", paidAt: new Date(t) }, "stripe");
    assert.ok(WEBHOOK_EVENT_SCHEMAS["order.paid"].safeParse(op.data).success);
    assert.equal(op.dedupKey, "order.paid:o1");
  });
});
