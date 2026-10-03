// Marketr — Phase 17 slice 3 tests: inventory + purchase orders.
// Run: npx tsx --test lib/ops/__tests__/inventory.test.ts
// RLS block also needs: OPS_SCRATCH=1 DATABASE_URL=<ops_slice1_scratch url>
//
// Proves (stub tx unless marked RLS):
//   - stock moves are atomic: txn row + stockQty increment in one call; the
//     balance can never drift from the ledger
//   - stockQty is NOT directly patchable (moves go through the txn ledger)
//   - lowStockThreshold IS patchable and low-stock alerts fire at/below
//     threshold (untracked products never alert)
//   - PO draft create is a free logged write with server-computed totals;
//     attacker-supplied status/totals are ignored
//   - PO send is a gated money write (OPS_PO_SEND): 202 + approval_required
//     executes nothing; send without an approval, with a missing approval,
//     or with a binding mismatch all halt (OpsGateError)
//   - PO cancel is gated (OPS_RECORD_DELETE); PO receive is a free
//     fulfillment write that books restock txns atomically and idempotently
//   - RLS: ops_purchase_orders is tenant-isolated on the scratch DB

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Prisma } from "@prisma/client";
import { approvalClaimDelegate } from "./approval-claims";

import { OPS_ENTITY_MAP } from "../entities";
import {
  OpsError,
  OpsNotFoundError,
  opsCreate,
  opsPatch,
  recordInventoryTxn,
  type OpsActor,
} from "../doctype";
import {
  OpsGateError,
  opsBindingFor,
  type OpsGatePort,
} from "../gate";
import { isLowStock, lowStockProducts } from "../inventory";

const ACTOR: OpsActor = { workspaceId: "ws_inv3", userId: "user_inv3" };
const PRODUCTS = OPS_ENTITY_MAP["products"];
const TXNS = OPS_ENTITY_MAP["inventory-txns"];
const POS = OPS_ENTITY_MAP["purchase-orders"];

// ---------------------------------------------------------------------------
// Stub tx: in-memory delegates + captured audits/creates/updates
// (same shape as doctype-conformance.test.ts).
// ---------------------------------------------------------------------------

interface StubCalls {
  audits: Array<Record<string, unknown>>;
  creates: Array<{ delegate: string; data: Record<string, unknown> }>;
  updates: Array<{ delegate: string; where: Record<string, unknown>; data: Record<string, unknown> }>;
}

function makeStubTx(seed: Record<string, Array<Record<string, unknown>>> = {}) {
  const store: Record<string, Array<Record<string, unknown>>> = {};
  for (const [k, rows] of Object.entries(seed)) store[k] = rows.map((r) => ({ ...r }));
  const calls: StubCalls = { audits: [], creates: [], updates: [] };
  const claims = approvalClaimDelegate();

  const delegate = (name: string) => ({
    findMany: async (args: { where?: Record<string, unknown> }) => {
      const rows = store[name] ?? [];
      const where = args?.where ?? {};
      return rows.filter((r) => Object.entries(where).every(([k, v]) => r[k] === v));
    },
    findFirst: async (args: { where?: Record<string, unknown> }) => {
      const rows = store[name] ?? [];
      const where = args?.where ?? {};
      return rows.find((r) => Object.entries(where).every(([k, v]) => r[k] === v)) ?? null;
    },
    create: async (args: { data: Record<string, unknown> }) => {
      const row = {
        id: `stub_${name}_${(store[name] ?? []).length}`,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...args.data,
      };
      (store[name] ??= []).push(row);
      calls.creates.push({ delegate: name, data: args.data });
      return row;
    },
    updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      // Status-guarded writes (transition table): every where key must match.
      const rows = (store[name] ?? []).filter((r) =>
        Object.entries(args.where).every(([k, v]) => r[k] === v),
      );
      for (const row of rows) Object.assign(row, args.data);
      if (rows.length) calls.updates.push({ delegate: name, where: args.where, data: args.data });
      return { count: rows.length };
    },
    update: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const rows = store[name] ?? [];
      const row = rows.find((r) => r.id === args.where.id);
      if (!row) {
        const e = new Error("not found") as Error & { code: string };
        e.code = "P2025";
        throw e;
      }
      const data = { ...args.data };
      for (const [k, v] of Object.entries(data)) {
        if (v && typeof v === "object" && "increment" in (v as Record<string, unknown>)) {
          (row as Record<string, unknown>)[k] =
            (((row as Record<string, unknown>)[k] as number) ?? 0) +
            ((v as Record<string, unknown>).increment as number);
          delete (data as Record<string, unknown>)[k];
        }
      }
      Object.assign(row, data);
      calls.updates.push({ delegate: name, where: args.where, data: args.data });
      return row;
    },
  });

  const tx = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === "composioActionApproval") return claims;
        if (prop === "opsAuditEvent") {
          return {
            create: async (args: { data: Record<string, unknown> }) => {
              calls.audits.push(args.data);
              return args.data;
            },
          };
        }
        return delegate(prop);
      },
    },
  );
  return { tx: tx as unknown as Prisma.TransactionClient, store, calls };
}

/** Gate port stub: propose mints a pending approval; getApproval serves a canned one. */
function stubGatePort(approval?: {
  status: string;
  proposedArgs: unknown;
  expiresAt?: Date;
} | null): OpsGatePort {
  return {
    propose: async () => ({ id: "ap_stub_1", status: "pending", riskTier: "medium" }),
    getApproval: async (_ws, id) => {
      if (!approval) throw new Error("Approval not found");
      return {
        id,
        status: approval.status,
        expiresAt: approval.expiresAt ?? new Date(Date.now() + 3600_000),
        proposedArgs: approval.proposedArgs,
      };
    },
  };
}

function trackedProduct(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "prod_tracked",
    workspaceId: ACTOR.workspaceId,
    name: "Widget",
    sku: "W-1",
    priceCents: 1000,
    stockQty: 10,
    trackInventory: true,
    lowStockThreshold: 3,
    ...overrides,
  };
}

const DRAFT_PO: Record<string, unknown> = {
  id: "po_1",
  workspaceId: ACTOR.workspaceId,
  supplierId: null,
  supplierName: "Acme Supply",
  lineItems: [
    { productId: "prod_tracked", name: "Widget", qty: 5, priceCents: 800 },
    { name: "Freight", qty: 1, priceCents: 1500 },
  ],
  taxCents: 320,
  totalCents: 5820,
  status: "draft",
  sentAt: null,
  receivedAt: null,
};

// ---------------------------------------------------------------------------
// Stock moves: atomic txn + balance.
// ---------------------------------------------------------------------------

describe("stock moves (stub tx)", () => {
  it("records a txn row AND increments the balance in one call (no drift)", async () => {
    const { tx, calls } = makeStubTx({ opsProduct: [trackedProduct()] });
    const row = await recordInventoryTxn(tx, ACTOR, {
      productId: "prod_tracked",
      delta: -2,
      reason: "sale",
    });
    assert.equal(row.delta, -2);
    assert.equal(row.reason, "sale");
    const txnCreates = calls.creates.filter((c) => c.delegate === "opsInventoryTxn");
    assert.equal(txnCreates.length, 1);
    const prodUpdates = calls.updates.filter((c) => c.delegate === "opsProduct");
    assert.equal(prodUpdates.length, 1);
    assert.deepEqual(prodUpdates[0]!.data, {
      stockQty: { increment: -2 },
    });
  });

  it("restocks positively and accepts a note + explicit actor", async () => {
    const { tx, calls } = makeStubTx({ opsProduct: [trackedProduct({ stockQty: 0 })] });
    await recordInventoryTxn(tx, ACTOR, {
      productId: "prod_tracked",
      delta: 25,
      reason: "restock",
      note: "PO-123",
      actorName: "agent:ops",
    });
    const create = calls.creates.find((c) => c.delegate === "opsInventoryTxn")!;
    assert.equal(create.data.note, "PO-123");
    assert.equal(create.data.actor, "agent:ops");
    const upd = calls.updates.find((c) => c.delegate === "opsProduct")!;
    assert.deepEqual(upd.data, { stockQty: { increment: 25 } });
  });

  it("rejects zero and non-integer deltas (400)", async () => {
    const { tx } = makeStubTx({ opsProduct: [trackedProduct()] });
    for (const delta of [0, 1.5, NaN]) {
      await assert.rejects(
        recordInventoryTxn(tx, ACTOR, { productId: "prod_tracked", delta, reason: "sale" }),
        (e: unknown) => e instanceof OpsError && e.status === 400,
        `delta ${delta} must 400`,
      );
    }
  });

  it("404s on an unknown product", async () => {
    const { tx } = makeStubTx({ opsProduct: [trackedProduct()] });
    await assert.rejects(
      recordInventoryTxn(tx, ACTOR, { productId: "prod_nope", delta: 1, reason: "restock" }),
      (e: unknown) => e instanceof OpsNotFoundError,
      "missing product must 404",
    );
  });

  it("422s on a product that does not track inventory", async () => {
    const { tx } = makeStubTx({
      opsProduct: [trackedProduct({ id: "prod_svc", trackInventory: false })],
    });
    await assert.rejects(
      recordInventoryTxn(tx, ACTOR, { productId: "prod_svc", delta: 1, reason: "sale" }),
      (e: unknown) => e instanceof OpsError && e.status === 422,
      "untracked product must 422",
    );
  });

  it("opsCreate(inventory-txns) books the move through the ledger (200)", async () => {
    const { tx, calls } = makeStubTx({ opsProduct: [trackedProduct({ stockQty: 7 })] });
    const res = await opsCreate(
      tx,
      TXNS,
      ACTOR,
      { productId: "prod_tracked", delta: 3, reason: "restock" },
      { gatePort: stubGatePort() },
    );
    assert.equal(res.outcome, "done");
    assert.equal(calls.creates.filter((c) => c.delegate === "opsInventoryTxn").length, 1);
    assert.equal(calls.updates.filter((c) => c.delegate === "opsProduct").length, 1);
  });
});

// ---------------------------------------------------------------------------
// Product patch rules: balance is ledger-only; threshold is writable.
// ---------------------------------------------------------------------------

describe("product patch rules (stub tx)", () => {
  it("stockQty is NOT directly patchable (400 — moves go through the ledger)", async () => {
    const { tx } = makeStubTx({ opsProduct: [trackedProduct()] });
    await assert.rejects(
      opsPatch(tx, PRODUCTS, ACTOR, { id: "prod_tracked", stockQty: 999 }, { gatePort: stubGatePort() }),
      (e: unknown) => e instanceof OpsError && e.status === 400,
      "direct stockQty write must 400",
    );
  });

  it("lowStockThreshold is a free writable patch", async () => {
    const { tx, calls } = makeStubTx({ opsProduct: [trackedProduct()] });
    const res = await opsPatch(
      tx,
      PRODUCTS,
      ACTOR,
      { id: "prod_tracked", lowStockThreshold: 5 },
      { gatePort: stubGatePort() },
    );
    assert.equal(res.outcome, "done");
    assert.equal((res.row as Record<string, unknown>).lowStockThreshold, 5);
    assert.equal(calls.audits[0]!.action, "update");
  });
});

// ---------------------------------------------------------------------------
// Low-stock alerts.
// ---------------------------------------------------------------------------

describe("low-stock alerts", () => {
  it("alerts at/below threshold for tracked products only", () => {
    assert.ok(isLowStock({ trackInventory: true, stockQty: 3, lowStockThreshold: 3 }), "equal alerts");
    assert.ok(isLowStock({ trackInventory: true, stockQty: 0, lowStockThreshold: 3 }), "below alerts");
    assert.ok(!isLowStock({ trackInventory: true, stockQty: 4, lowStockThreshold: 3 }), "above is quiet");
    assert.ok(!isLowStock({ trackInventory: false, stockQty: 0, lowStockThreshold: 3 }), "untracked never alerts");
    assert.ok(isLowStock({ trackInventory: true, stockQty: 0, lowStockThreshold: 0 }), "default 0 alerts when out of stock");
  });

  it("lowStockProducts filters the workspace list", async () => {
    const { tx } = makeStubTx({
      opsProduct: [
        trackedProduct({ id: "p_low", stockQty: 2, lowStockThreshold: 3 }),
        trackedProduct({ id: "p_ok", stockQty: 9, lowStockThreshold: 3 }),
        trackedProduct({ id: "p_untracked", trackInventory: false, stockQty: 0, lowStockThreshold: 5 }),
      ],
    });
    const rows = await lowStockProducts(tx, ACTOR);
    assert.deepEqual(rows.map((r) => r.id), ["p_low"]);
  });
});

// ---------------------------------------------------------------------------
// Purchase order drafts: free logged writes, server-computed totals.
// ---------------------------------------------------------------------------

describe("purchase-order drafts (stub tx)", () => {
  it("create is free (logged), forces draft, and computes totals server-side", async () => {
    const { tx, calls } = makeStubTx();
    const res = await opsCreate(
      tx,
      POS,
      ACTOR,
      {
        supplierName: "Acme Supply",
        lineItems: [
          { name: "Widget", qty: 5, priceCents: 800 },
          { name: "Freight", qty: 1, priceCents: 1500 },
        ],
        taxCents: 320,
      },
      { gatePort: stubGatePort() },
    );
    assert.equal(res.outcome, "done");
    const data = calls.creates.find((c) => c.delegate === "opsPurchaseOrder")!.data;
    assert.equal(data.status, "draft");
    assert.equal(data.subtotalCents, 5500);
    assert.equal(data.totalCents, 5820);
    assert.equal(data.supplierName, "Acme Supply");
    assert.equal(data.supplierId, null);
    assert.equal(calls.audits[0]!.action, "create");
  });

  it("ignores attacker-supplied status and totals", async () => {
    const { tx, calls } = makeStubTx();
    await opsCreate(
      tx,
      POS,
      ACTOR,
      {
        lineItems: [{ name: "Widget", qty: 1, priceCents: 100 }],
        taxCents: 0,
        status: "received",
        totalCents: 1,
        subtotalCents: 1,
      },
      { gatePort: stubGatePort() },
    );
    const data = calls.creates.find((c) => c.delegate === "opsPurchaseOrder")!.data;
    assert.equal(data.status, "draft", "status is server-forced");
    assert.equal(data.totalCents, 100, "totals are server-computed");
    assert.equal(data.subtotalCents, 100);
  });

  it("rejects empty line items (400)", async () => {
    const { tx } = makeStubTx();
    await assert.rejects(
      opsCreate(tx, POS, ACTOR, { lineItems: [] }, { gatePort: stubGatePort() }),
      (e: unknown) => e instanceof OpsError && e.status === 400,
      "empty lines must 400",
    );
  });
});

// ---------------------------------------------------------------------------
// PO send: gated money write (OPS_PO_SEND) — negatives included.
// ---------------------------------------------------------------------------

function sendBinding(entityId: string) {
  return {
    workspaceId: ACTOR.workspaceId,
    entity: "purchase-orders",
    entityId,
    slug: "OPS_PO_SEND",
    mutation: { id: entityId, status: "sent" },
  };
}

describe("purchase-order send (gated, stub tx)", () => {
  it("without an approval proposes and executes NOTHING", async () => {
    const { tx, calls } = makeStubTx({ opsPurchaseOrder: [{ ...DRAFT_PO }] });
    const res = await opsPatch(
      tx,
      POS,
      ACTOR,
      { id: "po_1", status: "sent" },
      { gatePort: stubGatePort() },
    );
    assert.equal(res.outcome, "approval_required");
    assert.equal(res.classification!.slug, "OPS_PO_SEND");
    assert.equal(res.classification!.mode, "gated");
    assert.ok(res.approval!.id, "approval id surfaces");
    assert.equal(calls.updates.length, 0, "the PO row must not move");
    assert.equal(
      calls.creates.filter((c) => c.delegate !== "opsAuditEvent").length,
      0,
      "no side effects",
    );
    assert.equal(calls.audits[0]!.action, "gate_proposed");
  });

  it("with an approved, correctly-bound approval sends and stamps sentAt", async () => {
    const { tx, calls } = makeStubTx({ opsPurchaseOrder: [{ ...DRAFT_PO }] });
    const res = await opsPatch(
      tx,
      POS,
      ACTOR,
      { id: "po_1", status: "sent", approvalId: "ap_stub_1" },
      { gatePort: stubGatePort({ status: "approved", proposedArgs: opsBindingFor(sendBinding("po_1")) }) },
    );
    assert.equal(res.outcome, "done");
    assert.equal(res.action, "gate_executed");
    assert.equal((res.row as Record<string, unknown>).status, "sent");
    assert.ok((res.row as Record<string, unknown>).sentAt, "sentAt stamped");
    assert.equal(calls.audits[calls.audits.length - 1]!.action, "gate_executed");
  });

  it("halts on a missing approval (OpsGateError)", async () => {
    const { tx, calls } = makeStubTx({ opsPurchaseOrder: [{ ...DRAFT_PO }] });
    await assert.rejects(
      opsPatch(
        tx,
        POS,
        ACTOR,
        { id: "po_1", status: "sent", approvalId: "ap_missing" },
        { gatePort: stubGatePort(null) },
      ),
      (e: unknown) => e instanceof OpsGateError && e.code === "approval_not_found",
      "unknown approval must halt",
    );
    assert.equal(calls.updates.length, 0, "nothing executed");
  });

  it("halts on a binding mismatch (OpsGateError)", async () => {
    const { tx, calls } = makeStubTx({ opsPurchaseOrder: [{ ...DRAFT_PO }] });
    const wrong = {
      ...sendBinding("po_1"),
      mutation: { id: "po_1", status: "received" },
    };
    await assert.rejects(
      opsPatch(
        tx,
        POS,
        ACTOR,
        { id: "po_1", status: "sent", approvalId: "ap_stub_1" },
        { gatePort: stubGatePort({ status: "approved", proposedArgs: opsBindingFor(wrong) }) },
      ),
      (e: unknown) => e instanceof OpsGateError && e.code === "binding_mismatch",
      "approval for a different mutation must halt",
    );
    assert.equal(calls.updates.length, 0, "nothing executed");
  });

  it("halts when the approval is not approved (denied)", async () => {
    const { tx } = makeStubTx({ opsPurchaseOrder: [{ ...DRAFT_PO }] });
    await assert.rejects(
      opsPatch(
        tx,
        POS,
        ACTOR,
        { id: "po_1", status: "sent", approvalId: "ap_stub_1" },
        { gatePort: stubGatePort({ status: "denied", proposedArgs: opsBindingFor(sendBinding("po_1")) }) },
      ),
      (e: unknown) => e instanceof OpsGateError && e.code === "approval_not_approved",
      "denied approval must halt",
    );
  });

  it("cancel is a gated write (OPS_RECORD_DELETE)", async () => {
    const { tx } = makeStubTx({ opsPurchaseOrder: [{ ...DRAFT_PO, status: "sent" }] });
    const res = await opsPatch(
      tx,
      POS,
      ACTOR,
      { id: "po_1", status: "cancelled" },
      { gatePort: stubGatePort() },
    );
    assert.equal(res.outcome, "approval_required");
    assert.equal(res.classification!.slug, "OPS_RECORD_DELETE");
  });
});

// ---------------------------------------------------------------------------
// PO receive: free fulfillment, atomic restock, idempotent.
// ---------------------------------------------------------------------------

describe("purchase-order receive (stub tx)", () => {
  it("books restock txns for product-linked lines and stamps receivedAt", async () => {
    const { tx, calls } = makeStubTx({
      opsPurchaseOrder: [{ ...DRAFT_PO, status: "sent" }],
      opsProduct: [trackedProduct({ stockQty: 10 })],
    });
    const res = await opsPatch(
      tx,
      POS,
      ACTOR,
      { id: "po_1", status: "received" },
      { gatePort: stubGatePort() },
    );
    assert.equal(res.outcome, "done", "receive is a free write");
    assert.equal((res.row as Record<string, unknown>).status, "received");
    assert.ok((res.row as Record<string, unknown>).receivedAt, "receivedAt stamped");
    assert.equal((res.row as { restocked: number }).restocked, 1, "one linked line restocked");
    const txnCreates = calls.creates.filter((c) => c.delegate === "opsInventoryTxn");
    assert.equal(txnCreates.length, 1, "exactly one restock txn");
    assert.equal(txnCreates[0]!.data.productId, "prod_tracked");
    assert.equal(txnCreates[0]!.data.delta, 5);
    assert.equal(txnCreates[0]!.data.reason, "restock");
    const prodUpdates = calls.updates.filter((c) => c.delegate === "opsProduct");
    assert.equal(prodUpdates.length, 1);
    assert.deepEqual(prodUpdates[0]!.data, { stockQty: { increment: 5 } });
  });

  it("is idempotent: a second receive is refused (409) and books nothing", async () => {
    const { tx, calls } = makeStubTx({
      opsPurchaseOrder: [{ ...DRAFT_PO, status: "received", receivedAt: new Date() }],
      opsProduct: [trackedProduct({ stockQty: 15 })],
    });
    await assert.rejects(
      opsPatch(tx, POS, ACTOR, { id: "po_1", status: "received" }, { gatePort: stubGatePort() }),
      (e: unknown) => e instanceof OpsError && e.status === 409,
      "received → received is not a transition",
    );
    assert.equal(
      calls.creates.filter((c) => c.delegate === "opsInventoryTxn").length,
      0,
      "no duplicate restocks",
    );
    assert.equal(
      calls.updates.filter((c) => c.delegate === "opsProduct").length,
      0,
      "no duplicate balance moves",
    );
  });

  it("receive 422s when a linked product does not track inventory", async () => {
    const { tx } = makeStubTx({
      opsPurchaseOrder: [{ ...DRAFT_PO, status: "sent" }],
      opsProduct: [trackedProduct({ trackInventory: false })],
    });
    await assert.rejects(
      opsPatch(tx, POS, ACTOR, { id: "po_1", status: "received" }, { gatePort: stubGatePort() }),
      (e: unknown) => e instanceof OpsError && e.status === 422,
      "untracked linked product must 422",
    );
  });
});

// ---------------------------------------------------------------------------
// RLS integration on the scratch DB (gated on OPS_SCRATCH=1 so the default
// suite never touches a live database).
// ---------------------------------------------------------------------------

const RUN_RLS = process.env.OPS_SCRATCH === "1";

(RUN_RLS ? describe : describe.skip)("purchase-order RLS isolation (scratch DB)", () => {
  let prisma: typeof import("@/lib/prisma").prisma;
  let withWorkspaceScope: typeof import("@/lib/substrate/memory/rls").withWorkspaceScope;
  const WS_A = "17s3-ws-a";
  const WS_B = "17s3-ws-b";

  before(async () => {
    ({ prisma } = await import("@/lib/prisma"));
    ({ withWorkspaceScope } = await import("@/lib/substrate/memory/rls"));
    for (const id of [WS_A, WS_B]) {
      await prisma.$executeRawUnsafe(`INSERT INTO workspaces (id) VALUES ('${id}') ON CONFLICT DO NOTHING`);
    }
  });

  after(async () => {
    for (const id of [WS_A, WS_B]) {
      await prisma.$executeRawUnsafe(`DELETE FROM workspaces WHERE id = '${id}'`);
    }
    await prisma.$disconnect();
  });

  it("ops_purchase_orders is tenant-isolated", async () => {
    const created = await withWorkspaceScope(WS_A, (tx) =>
      tx.opsPurchaseOrder.create({
        data: {
          workspaceId: WS_A,
          supplierName: "Acme Supply",
          lineItems: [{ name: "Widget", qty: 5, priceCents: 800 }],
          taxCents: 0,
          subtotalCents: 4000,
          totalCents: 4000,
          status: "draft",
        },
      }),
    );
    const seenB = await withWorkspaceScope(WS_B, (tx) =>
      tx.opsPurchaseOrder.findMany({ where: { workspaceId: WS_A } }),
    );
    assert.equal(seenB.length, 0, "B must not see A's purchase orders");
    const cross = await withWorkspaceScope(WS_B, (tx) =>
      tx.opsPurchaseOrder.findFirst({ where: { id: created.id, workspaceId: WS_B } }),
    );
    assert.equal(cross, null, "cross-workspace PO resolves to 404-shape null");
  });

  it("low_stock_threshold column persists a threshold patch", async () => {
    const p = await withWorkspaceScope(WS_A, (tx) =>
      tx.opsProduct.create({
        data: { workspaceId: WS_A, name: "Widget", sku: "W-S3", priceCents: 100 },
      }),
    );
    const updated = await withWorkspaceScope(WS_A, (tx) =>
      tx.opsProduct.update({ where: { id: p.id }, data: { lowStockThreshold: 7 } }),
    );
    assert.equal(updated.lowStockThreshold, 7);
    const seen = await withWorkspaceScope(WS_A, (tx) =>
      tx.opsProduct.findFirst({ where: { id: p.id } }),
    );
    assert.equal(seen!.lowStockThreshold, 7);
    const seenB = await withWorkspaceScope(WS_B, (tx) =>
      tx.opsProduct.findFirst({ where: { id: p.id, workspaceId: WS_B } }),
    );
    assert.equal(seenB, null, "B must not see A's products");
  });
});
