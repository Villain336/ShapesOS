// ShapesOS — Phase 2 (money & ops integrity) regression tests.
// Run: npx tsx --test lib/ops/__tests__/integrity.test.ts
//
// Each case is a finding from the 2026-10-03 audit (H10 + §5 ops):
//   - one approval = one execution (replay + concurrent replay blocked)
//   - status transition table (no draft→overdue, no paid→overdue,
//     PO received only after sent) and guarded restock (no double restock)
//   - tax/line patches recompute totals, drafts only
//   - totals bounded to the int4 column at validation
//   - invoice idempotency key returns the original invoice
//   - overdue sweep never overwrites a just-paid invoice
//   - list paging validates limit
//
// Runs against an in-memory stub tx that honours where-clauses the way
// Postgres would (guarded updateMany matches 0 rows once the row moved).
// The real-database consume path is ops-consume-db.test.ts.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Prisma } from "@prisma/client";

import { OPS_ENTITY_MAP, OPS_MAX_CENTS } from "../entities";
import { OpsError, opsCreate, opsList, opsPatch, type OpsActor } from "../doctype";
import { OpsGateError, opsBindingFor, type OpsGatePort } from "../gate";
import { executeInvoiceReminder, markOverdueInvoices } from "../invoices";
import { approvalClaimDelegate } from "./approval-claims";

const ACTOR: OpsActor = { workspaceId: "ws_p2e", userId: "user_p2e" };
const INVOICES = OPS_ENTITY_MAP["invoices"]!;
const ORDERS = OPS_ENTITY_MAP["orders"]!;
const POS = OPS_ENTITY_MAP["purchase-orders"]!;
const PAYMENTS = OPS_ENTITY_MAP["payments"]!;

type Row = Record<string, unknown>;

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v && typeof v === "object" && !(v instanceof Date)) {
      const op = v as { lt?: Date };
      if (op.lt) return row[k] != null && new Date(String(row[k])).getTime() < op.lt.getTime();
      return true;
    }
    return row[k] === v;
  });
}

function makeStubTx(seed: Record<string, Row[]> = {}) {
  const store: Record<string, Row[]> = {};
  for (const [k, rows] of Object.entries(seed)) store[k] = rows.map((r) => ({ ...r }));
  const audits: Row[] = [];
  const claims = approvalClaimDelegate();
  let seq = 0;
  const delegate = (name: string) => ({
    findMany: async (a: { where?: Row; take?: number }) => {
      const rows = (store[name] ?? []).filter((r) => matches(r, a?.where ?? {}));
      return (a?.take ? rows.slice(0, a.take) : rows).map((r) => ({ ...r }));
    },
    findFirst: async (a: { where?: Row }) => {
      const r = (store[name] ?? []).find((x) => matches(x, a?.where ?? {}));
      return r ? { ...r } : null;
    },
    create: async (a: { data: Row }) => {
      const row = { id: `${name}_${++seq}`, createdAt: new Date(), ...a.data };
      (store[name] ??= []).push(row);
      return { ...row };
    },
    upsert: async (a: { where: Record<string, Row>; create: Row }) => {
      const key = Object.values(a.where)[0]!;
      const hit = (store[name] ?? []).find((x) => matches(x, key));
      if (hit) return { ...hit };
      const row = { id: `${name}_${++seq}`, createdAt: new Date(), ...a.create };
      (store[name] ??= []).push(row);
      return { ...row };
    },
    updateMany: async (a: { where: Row; data: Row }) => {
      const rows = (store[name] ?? []).filter((r) => matches(r, a.where));
      for (const r of rows) Object.assign(r, a.data);
      return { count: rows.length };
    },
    update: async (a: { where: Row; data: Row }) => {
      const r = (store[name] ?? []).find((x) => x.id === a.where.id)!;
      for (const [k, v] of Object.entries(a.data)) {
        if (v && typeof v === "object" && "increment" in (v as Row)) {
          r[k] = Number(r[k] ?? 0) + Number((v as { increment: number }).increment);
        } else {
          r[k] = v;
        }
      }
      return { ...r };
    },
  });
  const tx = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === "composioActionApproval") return claims;
        if (prop === "opsAuditEvent") {
          return { create: async (a: { data: Row }) => (audits.push(a.data), a.data) };
        }
        return delegate(prop);
      },
    },
  );
  return { tx: tx as unknown as Prisma.TransactionClient, store, audits, claims };
}

/** A port whose single approval ("ap_1") is approved and bound to `binding`. */
function approvedPort(binding: Parameters<typeof opsBindingFor>[0]): OpsGatePort {
  return {
    propose: async () => ({ id: "ap_new", status: "pending", riskTier: "medium" }),
    getApproval: async (_ws, id) => ({
      id,
      status: "approved",
      expiresAt: new Date(Date.now() + 3600_000),
      proposedArgs: opsBindingFor(binding),
    }),
  };
}

const proposingPort: OpsGatePort = {
  propose: async () => ({ id: "ap_new", status: "pending", riskTier: "medium" }),
  getApproval: async () => {
    throw new Error("not found");
  },
};

const CHARGE = { kind: "charge", amountCents: 50_000, provider: "stripe", status: "succeeded" };

// ---------------------------------------------------------------------------
// H10 — approvals are consumed
// ---------------------------------------------------------------------------

describe("H10: one approval = one execution", () => {
  it("replaying one approved payment approval creates exactly one payment", async () => {
    const { tx, store, claims } = makeStubTx();
    // Bind to the zod-normalised body the service verifies against.
    const port = approvedPort({ entity: "payments", slug: "OPS_PAYMENT_RECORD_CHARGE", mutation: { ...CHARGE } });
    const first = await opsCreate(tx, PAYMENTS, ACTOR, { ...CHARGE, approvalId: "ap_1" }, { gatePort: port });
    assert.equal(first.outcome, "done");
    for (let i = 0; i < 2; i++) {
      await assert.rejects(
        opsCreate(tx, PAYMENTS, ACTOR, { ...CHARGE, approvalId: "ap_1" }, { gatePort: port }),
        (e: unknown) => e instanceof OpsGateError && e.code === "approval_replayed",
      );
    }
    assert.equal((store.opsPayment ?? []).length, 1, "payments created from ONE approval");
    assert.ok(claims.executed.has("ap_1"), "approval flipped to executed");
  });

  it("concurrent replays (Promise.all) still execute once", async () => {
    const { tx, store } = makeStubTx();
    const port = approvedPort({ entity: "payments", slug: "OPS_PAYMENT_RECORD_CHARGE", mutation: { ...CHARGE } });
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        opsCreate(tx, PAYMENTS, ACTOR, { ...CHARGE, approvalId: "ap_1" }, { gatePort: port }),
      ),
    );
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal((store.opsPayment ?? []).length, 1);
  });

  it("a payment reminder approval sends one reminder", async () => {
    const { tx, audits } = makeStubTx({
      opsInvoice: [{ id: "inv_1", workspaceId: ACTOR.workspaceId, status: "sent", totalCents: 100, customerId: null }],
    });
    const port = approvedPort({
      entity: "invoices",
      entityId: "inv_1",
      slug: "OPS_INVOICE_REMIND",
      mutation: { id: "inv_1", reminderText: "Please pay." },
    });
    await executeInvoiceReminder(tx, ACTOR, "inv_1", "Please pay.", "ap_1", { gatePort: port });
    await assert.rejects(
      executeInvoiceReminder(tx, ACTOR, "inv_1", "Please pay.", "ap_1", { gatePort: port }),
      (e: unknown) => e instanceof OpsGateError && e.code === "approval_replayed",
    );
    assert.equal(audits.filter((a) => a.action === "reminder_sent").length, 1);
  });

  it("a gated status patch consumes its approval (mark paid twice → one write)", async () => {
    const { tx } = makeStubTx({
      opsInvoice: [{ id: "inv_1", workspaceId: ACTOR.workspaceId, status: "sent", totalCents: 100, lineItems: [] }],
    });
    const port = approvedPort({
      entity: "invoices",
      entityId: "inv_1",
      slug: "OPS_INVOICE_MARK_PAID",
      mutation: { id: "inv_1", status: "paid" },
    });
    const r = await opsPatch(tx, INVOICES, ACTOR, { id: "inv_1", status: "paid", approvalId: "ap_1" }, { gatePort: port });
    assert.equal((r as { row: Row }).row.status, "paid");
    await assert.rejects(
      opsPatch(tx, INVOICES, ACTOR, { id: "inv_1", status: "paid", approvalId: "ap_1" }, { gatePort: port }),
      (e: unknown) => e instanceof OpsError && e.status === 409,
      "paid → paid is not a transition",
    );
  });
});

// ---------------------------------------------------------------------------
// Transition table + guarded restock
// ---------------------------------------------------------------------------

const lines = [{ description: "x", qty: 1, priceCents: 1000 }];

describe("status transition table", () => {
  it("invoice draft → overdue is refused (409), nothing proposed or written", async () => {
    const { tx, store } = makeStubTx();
    const c = await opsCreate(tx, INVOICES, ACTOR, { lineItems: lines });
    const id = String((c as { row: Row }).row.id);
    await assert.rejects(
      opsPatch(tx, INVOICES, ACTOR, { id, status: "overdue" }),
      (e: unknown) => e instanceof OpsError && e.status === 409,
    );
    assert.equal(store.opsInvoice![0]!.status, "draft");
  });

  it("invoice paid → overdue and paid → cancelled are refused before any approval is minted", async () => {
    const { tx, audits } = makeStubTx({
      opsInvoice: [{ id: "inv_p", workspaceId: ACTOR.workspaceId, status: "paid", totalCents: 1000, lineItems: lines }],
    });
    for (const status of ["overdue", "cancelled", "sent"]) {
      await assert.rejects(
        opsPatch(tx, INVOICES, ACTOR, { id: "inv_p", status }, { gatePort: proposingPort }),
        (e: unknown) => e instanceof OpsError && e.status === 409,
        `paid → ${status}`,
      );
    }
    assert.equal(audits.filter((a) => a.action === "gate_proposed").length, 0);
  });

  it("order draft → fulfilled is refused; draft → confirmed is allowed", async () => {
    const { tx } = makeStubTx({
      opsOrder: [{ id: "o_1", workspaceId: ACTOR.workspaceId, status: "draft", totalCents: 1000, taxCents: 0, lineItems: [] }],
    });
    await assert.rejects(
      opsPatch(tx, ORDERS, ACTOR, { id: "o_1", status: "fulfilled" }, { gatePort: proposingPort }),
      (e: unknown) => e instanceof OpsError && e.status === 409,
    );
    const r = await opsPatch(tx, ORDERS, ACTOR, { id: "o_1", status: "confirmed" });
    assert.equal((r as { row: Row }).row.status, "confirmed");
  });

  it("PO draft → received is refused (never sent) — no restock", async () => {
    const { tx, store } = makeStubTx({
      opsPurchaseOrder: [{ id: "po_1", workspaceId: ACTOR.workspaceId, status: "draft", lineItems: [{ productId: "p1", name: "w", qty: 10, priceCents: 1 }] }],
      opsProduct: [{ id: "p1", workspaceId: ACTOR.workspaceId, trackInventory: true, stockQty: 0 }],
    });
    await assert.rejects(
      opsPatch(tx, POS, ACTOR, { id: "po_1", status: "received" }),
      (e: unknown) => e instanceof OpsError && e.status === 409,
    );
    assert.equal(store.opsProduct![0]!.stockQty, 0);
    assert.equal((store.opsInventoryTxn ?? []).length, 0);
  });

  it("two concurrent receives (Promise.all) restock exactly once", async () => {
    const { tx, store } = makeStubTx({
      opsPurchaseOrder: [{ id: "po_1", workspaceId: ACTOR.workspaceId, status: "sent", lineItems: [{ productId: "p1", name: "w", qty: 10, priceCents: 1 }] }],
      opsProduct: [{ id: "p1", workspaceId: ACTOR.workspaceId, trackInventory: true, stockQty: 0 }],
    });
    const results = await Promise.allSettled([
      opsPatch(tx, POS, ACTOR, { id: "po_1", status: "received" }),
      opsPatch(tx, POS, ACTOR, { id: "po_1", status: "received" }),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    assert.ok(rejected.reason instanceof OpsError && rejected.reason.status === 409);
    assert.equal(store.opsProduct![0]!.stockQty, 10, "stock moved once");
    assert.equal((store.opsInventoryTxn ?? []).length, 1, "one restock txn");
  });
});

// ---------------------------------------------------------------------------
// Totals: recompute on patch (drafts only) + int4 bounds
// ---------------------------------------------------------------------------

describe("totals", () => {
  it("patching taxCents on a draft recomputes totalCents", async () => {
    const { tx } = makeStubTx();
    const c = await opsCreate(tx, INVOICES, ACTOR, { lineItems: lines, taxCents: 100 });
    const id = String((c as { row: Row }).row.id);
    const p = await opsPatch(tx, INVOICES, ACTOR, { id, taxCents: 900 });
    assert.equal((p as { row: Row }).row.taxCents, 900);
    assert.equal((p as { row: Row }).row.totalCents, 1900);
  });

  it("patching line items on a draft order recomputes subtotal + total", async () => {
    const { tx } = makeStubTx();
    const c = await opsCreate(tx, ORDERS, ACTOR, { lineItems: [{ name: "a", qty: 1, priceCents: 100 }], taxCents: 5 });
    const id = String((c as { row: Row }).row.id);
    const p = await opsPatch(tx, ORDERS, ACTOR, { id, lineItems: [{ name: "a", qty: 3, priceCents: 100 }] });
    assert.equal((p as { row: Row }).row.subtotalCents, 300);
    assert.equal((p as { row: Row }).row.totalCents, 305);
  });

  it("tax/line edits to a sent invoice are refused (409)", async () => {
    const { tx } = makeStubTx({
      opsInvoice: [{ id: "inv_s", workspaceId: ACTOR.workspaceId, status: "sent", taxCents: 0, totalCents: 1000, lineItems: lines }],
    });
    await assert.rejects(
      opsPatch(tx, INVOICES, ACTOR, { id: "inv_s", taxCents: 50 }),
      (e: unknown) => e instanceof OpsError && e.status === 409,
    );
  });

  it("totals above the int4 column are a 400 at validation, not a Prisma 500", async () => {
    const { tx, store } = makeStubTx();
    await assert.rejects(
      opsCreate(tx, INVOICES, ACTOR, { lineItems: [{ description: "x", qty: 3, priceCents: 1_000_000_000 }] }),
      (e: unknown) => e instanceof OpsError && e.status === 400 && /maximum/.test(e.message),
    );
    await assert.rejects(
      opsCreate(tx, POS, ACTOR, { lineItems: [{ name: "x", qty: 2, priceCents: 1_000_000_000 }], taxCents: 147_483_648 }),
      (e: unknown) => e instanceof OpsError && e.status === 400,
    );
    await assert.rejects(
      opsCreate(tx, PAYMENTS, ACTOR, { kind: "charge", amountCents: OPS_MAX_CENTS + 1 }),
      (e: unknown) => e instanceof OpsError && e.status === 400,
    );
    assert.equal((store.opsInvoice ?? []).length, 0);
    // Exactly at the bound is fine.
    const ok = await opsCreate(tx, INVOICES, ACTOR, { lineItems: [{ description: "x", qty: 2, priceCents: 1_000_000_000 }], taxCents: 147_483_647 });
    assert.equal((ok as { row: Row }).row.totalCents, OPS_MAX_CENTS);
  });

  it("a tax patch that would overflow int4 is a 400", async () => {
    const { tx } = makeStubTx();
    const c = await opsCreate(tx, INVOICES, ACTOR, { lineItems: [{ description: "x", qty: 2, priceCents: 1_000_000_000 }] });
    const id = String((c as { row: Row }).row.id);
    await assert.rejects(
      opsPatch(tx, INVOICES, ACTOR, { id, taxCents: 147_483_648 }),
      (e: unknown) => e instanceof OpsError && e.status === 400,
    );
  });
});

// ---------------------------------------------------------------------------
// Idempotency key, overdue sweep, paging
// ---------------------------------------------------------------------------

describe("invoice idempotency key", () => {
  it("a reused key returns the original invoice (no second row, no error)", async () => {
    const { tx, store } = makeStubTx();
    const a = await opsCreate(tx, INVOICES, ACTOR, { lineItems: lines, idempotencyKey: "k-1" });
    const b = await opsCreate(tx, INVOICES, ACTOR, { lineItems: lines, idempotencyKey: "k-1" });
    assert.equal(a.outcome, "done");
    assert.equal(b.outcome, "done");
    assert.equal((b as { action: string }).action, "idempotent_replay");
    assert.equal((b as { row: Row }).row.id, (a as { row: Row }).row.id);
    assert.equal(store.opsInvoice!.length, 1);
  });

  it("concurrent creates with one key resolve to one invoice", async () => {
    const { tx, store } = makeStubTx();
    const rs = await Promise.all(
      Array.from({ length: 4 }, () => opsCreate(tx, INVOICES, ACTOR, { lineItems: lines, idempotencyKey: "k-2" })),
    );
    assert.equal(new Set(rs.map((r) => (r as { row: Row }).row.id)).size, 1);
    assert.equal(store.opsInvoice!.length, 1);
  });
});

describe("overdue sweep", () => {
  it("does not overwrite an invoice paid between the read and the write", async () => {
    const past = new Date(Date.now() - 86_400_000);
    const { tx, store } = makeStubTx({
      opsInvoice: [
        { id: "inv_a", workspaceId: ACTOR.workspaceId, status: "sent", dueAt: past, totalCents: 100 },
        { id: "inv_b", workspaceId: ACTOR.workspaceId, status: "sent", dueAt: past, totalCents: 200 },
      ],
    });
    // Simulate the race: inv_b is marked paid right after the sweep's read.
    const realTx = tx as unknown as { opsInvoice: { findMany(a: unknown): Promise<Row[]> } };
    const findMany = realTx.opsInvoice.findMany;
    const racing = new Proxy(tx as object, {
      get(t, prop: string) {
        const d = (t as Record<string, unknown>)[prop];
        if (prop !== "opsInvoice") return d;
        return {
          ...(d as object),
          findMany: async (a: unknown) => {
            const rows = await findMany(a);
            store.opsInvoice!.find((r) => r.id === "inv_b")!.status = "paid";
            return rows;
          },
        };
      },
    }) as unknown as Prisma.TransactionClient;
    const res = await markOverdueInvoices(racing, ACTOR);
    assert.deepEqual(res.ids, ["inv_a"]);
    assert.equal(store.opsInvoice!.find((r) => r.id === "inv_b")!.status, "paid");
  });
});

describe("list paging", () => {
  it("rejects non-integer / non-positive limits with 400 and clamps the max", async () => {
    const { tx } = makeStubTx();
    for (const limit of [1.5, Number.NaN, 0, -3]) {
      await assert.rejects(
        opsList(tx, INVOICES, ACTOR, { limit }),
        (e: unknown) => e instanceof OpsError && e.status === 400,
        `limit ${limit}`,
      );
    }
    const ok = await opsList(tx, INVOICES, ACTOR, { limit: 5000 });
    assert.deepEqual(ok.rows, []);
  });
});
