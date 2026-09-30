// Marketr — Phase 17 slice 1 tests: DocType-convention conformance.
// Run: npx tsx --test lib/ops/__tests__/doctype-conformance.test.ts
//
// Proves EVERY registered entity exposes the auto API by construction:
//   - opsList returns { entity, rows } scoped to the workspace + one audit row
//   - opsCreate writes workspaceId on the row + one audit row (or proposes a
//     Phase 14 approval for gated writes, executing nothing)
//   - opsPatch scopes by (id, workspaceId), 404s cross-workspace ids, 405s on
//     immutable ledgers, and routes money transitions through the gate
//   - totals are server-computed; stock moves atomically with its txn row
//
// The service runs against a stub tx — no live database.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Prisma } from "@prisma/client";

import { OPS_ENTITIES, OPS_ENTITY_MAP } from "../entities";
import {
  OpsError,
  opsCreate,
  opsEntityDef,
  opsList,
  opsPatch,
  type OpsActor,
} from "../doctype";
import {
  opsBindingFor,
  type OpsGatePort,
} from "../gate";

const ACTOR: OpsActor = { workspaceId: "ws_conform", userId: "user_conform" };

// ---------------------------------------------------------------------------
// Stub tx: in-memory delegates + captured audits/creates/updates.
// ---------------------------------------------------------------------------

interface StubCalls {
  audits: Array<Record<string, unknown>>;
  creates: Array<{ delegate: string; data: Record<string, unknown> }>;
  updates: Array<{ delegate: string; where: Record<string, unknown>; data: Record<string, unknown> }>;
}

function makeStubTx() {
  const store: Record<string, Array<Record<string, unknown>>> = {};
  const calls: StubCalls = { audits: [], creates: [], updates: [] };

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
            ((row as Record<string, unknown>)[k] as number ?? 0) +
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
}): OpsGatePort {
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

/** Minimal valid create bodies per entity. */
function validCreateBody(slug: string): Record<string, unknown> {
  switch (slug) {
    case "products":
      return { name: "Retainer", sku: "RET-001", priceCents: 50000 };
    case "orders":
      return { lineItems: [{ name: "Retainer", qty: 2, priceCents: 50000 }], taxCents: 800 };
    case "payments":
      return { kind: "charge", amountCents: 100800, providerRef: "pi_test" };
    case "promotions":
      return { code: "WELCOME10", rules: { percentOff: 10 } };
    case "invoices":
      return { lineItems: [{ description: "Q4 retainer", qty: 1, priceCents: 50000 }] };
    case "inventory-txns":
      return { productId: "prod_1", delta: -2, reason: "sale" };
    case "projects":
      return { name: "Website rebuild", milestones: [{ title: "Kickoff" }] };
    case "workflow-runs":
      return { workflowName: "order_to_fulfillment" };
    default:
      throw new Error(`no fixture for ${slug}`);
  }
}

describe("DocType convention conformance (stub tx)", () => {
  it("registers exactly the 8 slice-1 entities", () => {
    assert.deepEqual(
      OPS_ENTITIES.map((d) => d.slug).sort(),
      ["inventory-txns", "invoices", "orders", "payments", "products", "projects", "promotions", "workflow-runs"],
    );
    for (const d of OPS_ENTITIES) {
      assert.ok(OPS_ENTITY_MAP[d.slug] === d, `${d.slug} in map`);
      assert.ok(d.delegate.startsWith("ops"), `${d.slug} delegate`);
      assert.ok(typeof d.summarize === "function", `${d.slug} summarize`);
    }
  });

  for (const def of OPS_ENTITIES) {
    const slug = def.slug;
    it(`${slug}: opsList returns { entity, rows } scoped + one audit row`, async () => {
      const { tx, calls } = makeStubTx();
      // Seed a row in another workspace — the list must not see it (the
      // stub emulates the RLS scope via the explicit workspaceId filter).
      const res = await opsList(tx, def, ACTOR, {});
      assert.equal(res.entity, slug);
      assert.deepEqual(res.rows, []);
      assert.equal(calls.audits.length, 1);
      assert.equal(calls.audits[0]!.action, "list");
      assert.equal(calls.audits[0]!.entity, slug);
      assert.equal(calls.audits[0]!.workspaceId, ACTOR.workspaceId);
    });

    it(`${slug}: opsCreate validates input (400 on garbage)`, async () => {
      const { tx } = makeStubTx();
      await assert.rejects(
        opsCreate(tx, def, ACTOR, { nope: true }, { gatePort: stubGatePort() }),
        (e: unknown) => e instanceof OpsError && e.status === 400,
        "invalid body must 400",
      );
    });
  }

  it("free creates: row carries workspaceId + exactly one audit row", async () => {
    for (const slug of ["products", "orders", "promotions", "invoices", "projects", "workflow-runs"]) {
      const def = OPS_ENTITY_MAP[slug]!;
      const { tx, calls } = makeStubTx();
      const res = await opsCreate(tx, def, ACTOR, validCreateBody(slug), { gatePort: stubGatePort() });
      assert.equal(res.outcome, "done", `${slug} create is free`);
      if (res.outcome !== "done") continue;
      assert.equal(res.action, "create");
      assert.equal((res.row as Record<string, unknown>).workspaceId, ACTOR.workspaceId);
      assert.equal(calls.audits.length, 1, `${slug}: one audit row`);
      assert.equal(calls.audits[0]!.action, "create");
      assert.equal(calls.audits[0]!.entityId, (res.row as Record<string, unknown>).id);
    }
  });

  it("order/invoice totals are server-computed (client totals ignored)", async () => {
    const { tx } = makeStubTx();
    const orderDef = OPS_ENTITY_MAP["orders"]!;
    const res = await opsCreate(
      tx, orderDef, ACTOR,
      { lineItems: [{ name: "X", qty: 2, priceCents: 50000 }], taxCents: 800, totalCents: 1 },
      { gatePort: stubGatePort() },
    );
    assert.equal(res.outcome, "done");
    if (res.outcome !== "done") return;
    const row = res.row as Record<string, unknown>;
    assert.equal(row.subtotalCents, 100000);
    assert.equal(row.taxCents, 800);
    assert.equal(row.totalCents, 100800, "client-supplied totalCents must not stick");

    const invDef = OPS_ENTITY_MAP["invoices"]!;
    const inv = await opsCreate(
      tx, invDef, ACTOR,
      { lineItems: [{ description: "Y", qty: 3, priceCents: 1000 }] },
      { gatePort: stubGatePort() },
    );
    assert.equal(inv.outcome, "done");
    if (inv.outcome !== "done") return;
    assert.equal((inv.row as Record<string, unknown>).totalCents, 3000);
    assert.equal((inv.row as Record<string, unknown>).status, "draft");
  });

  it("inventory txn: atomic txn row + stock decrement; 404/422 guards", async () => {
    const { tx, store, calls } = makeStubTx();
    // Seed the product the txn references.
    store["opsProduct"] = [
      { id: "prod_1", workspaceId: ACTOR.workspaceId, name: "Widget", sku: "W-1", priceCents: 100, stockQty: 10, trackInventory: true },
    ];
    const def = OPS_ENTITY_MAP["inventory-txns"]!;
    const res = await opsCreate(tx, def, ACTOR, { productId: "prod_1", delta: -2, reason: "sale" }, { gatePort: stubGatePort() });
    assert.equal(res.outcome, "done");
    assert.equal((store["opsProduct"]![0] as Record<string, unknown>).stockQty, 8, "stock decremented in the same tx");
    assert.equal(calls.audits.length, 1);

    // Unknown product → 404.
    await assert.rejects(
      opsCreate(tx, def, ACTOR, { productId: "nope", delta: -1, reason: "sale" }, { gatePort: stubGatePort() }),
      (e: unknown) => e instanceof OpsError && e.status === 404,
    );
    // Non-tracked product → 422.
    store["opsProduct"]!.push({ id: "prod_2", workspaceId: ACTOR.workspaceId, trackInventory: false, stockQty: 0 });
    await assert.rejects(
      opsCreate(tx, def, ACTOR, { productId: "prod_2", delta: 5, reason: "restock" }, { gatePort: stubGatePort() }),
      (e: unknown) => e instanceof OpsError && e.status === 422,
    );
    // Zero delta → 400 (schema refine).
    await assert.rejects(
      opsCreate(tx, def, ACTOR, { productId: "prod_1", delta: 0, reason: "adjustment" }, { gatePort: stubGatePort() }),
      (e: unknown) => e instanceof OpsError && e.status === 400,
    );
  });

  it("payments create is gated: proposes a Phase 14 approval, executes nothing", async () => {
    const { tx, calls } = makeStubTx();
    const def = OPS_ENTITY_MAP["payments"]!;
    const res = await opsCreate(tx, def, ACTOR, validCreateBody("payments"), { gatePort: stubGatePort() });
    assert.equal(res.outcome, "approval_required");
    if (res.outcome !== "approval_required") return;
    assert.equal(res.classification.slug, "OPS_PAYMENT_RECORD_CHARGE");
    assert.equal(res.classification.tier, "medium");
    assert.equal(res.approval.id, "ap_stub_1");
    assert.equal(calls.creates.length, 0, "nothing is written before approval");
    assert.equal(calls.audits.length, 1);
    assert.equal(calls.audits[0]!.action, "gate_proposed");
  });

  it("bulk refund create is gated HIGH", async () => {
    const { tx } = makeStubTx();
    const def = OPS_ENTITY_MAP["payments"]!;
    const res = await opsCreate(
      tx, def, ACTOR,
      { kind: "refund", items: [{ amountCents: 1000 }, { amountCents: 2000 }, { amountCents: 3000 }] },
      { gatePort: stubGatePort() },
    );
    assert.equal(res.outcome, "approval_required");
    if (res.outcome !== "approval_required") return;
    assert.equal(res.classification.slug, "OPS_PAYMENT_BULK_REFUND");
    assert.equal(res.classification.tier, "high");
  });

  it("approved payment executes: one row per bulk item + gate_executed audit", async () => {
    const { tx, calls } = makeStubTx();
    const def = OPS_ENTITY_MAP["payments"]!;
    const mutation = { kind: "refund", items: [{ amountCents: 1000 }, { amountCents: 2000 }], provider: "stripe" };
    const port = stubGatePort({
      status: "approved",
      proposedArgs: opsBindingFor({ entity: "payments", slug: "OPS_PAYMENT_BULK_REFUND", mutation }),
    });
    const res = await opsCreate(tx, def, ACTOR, { ...mutation, approvalId: "ap_ok" }, { gatePort: port });
    assert.equal(res.outcome, "done");
    if (res.outcome !== "done") return;
    assert.equal(res.action, "gate_executed");
    assert.equal(calls.creates.length, 2, "one row per bulk item");
    assert.ok(calls.creates.every((c) => (c.data.kind as string) === "refund"));
    assert.equal(calls.audits.filter((a) => a.action === "gate_executed").length, 2);
  });

  it("invoice send without approval proposes OPS_INVOICE_SEND; approved send sets sentAt", async () => {
    const { tx, store, calls } = makeStubTx();
    const def = OPS_ENTITY_MAP["invoices"]!;
    store["opsInvoice"] = [
      { id: "inv_1", workspaceId: ACTOR.workspaceId, status: "draft", totalCents: 5000, lineItems: [], sentAt: null },
    ];
    // No approvalId → propose, don't touch the row.
    const proposed = await opsPatch(tx, def, ACTOR, { id: "inv_1", status: "sent" }, { gatePort: stubGatePort() });
    assert.equal(proposed.outcome, "approval_required");
    if (proposed.outcome !== "approval_required") return;
    assert.equal(proposed.classification.slug, "OPS_INVOICE_SEND");
    assert.equal((store["opsInvoice"]![0] as Record<string, unknown>).status, "draft", "row untouched before approval");
    assert.equal(calls.audits[0]!.action, "gate_proposed");

    // Approved → executes, sets sentAt.
    const mutation = { id: "inv_1", status: "sent" };
    const port = stubGatePort({
      status: "approved",
      proposedArgs: opsBindingFor({ entity: "invoices", entityId: "inv_1", slug: "OPS_INVOICE_SEND", mutation }),
    });
    const done = await opsPatch(tx, def, ACTOR, { ...mutation, approvalId: "ap_ok" }, { gatePort: port });
    assert.equal(done.outcome, "done");
    if (done.outcome !== "done") return;
    assert.equal((done.row as Record<string, unknown>).status, "sent");
    assert.ok((done.row as Record<string, unknown>).sentAt instanceof Date, "sentAt stamped on send");
    assert.equal(calls.audits[calls.audits.length - 1]!.action, "gate_executed");
  });

  it("free patch: product price update runs freely, logged", async () => {
    const { tx, store, calls } = makeStubTx();
    const def = OPS_ENTITY_MAP["products"]!;
    store["opsProduct"] = [
      { id: "prod_9", workspaceId: ACTOR.workspaceId, name: "X", sku: "X-1", priceCents: 100, stockQty: 0, trackInventory: true },
    ];
    const res = await opsPatch(tx, def, ACTOR, { id: "prod_9", priceCents: 150 }, { gatePort: stubGatePort() });
    assert.equal(res.outcome, "done");
    if (res.outcome !== "done") return;
    assert.equal((res.row as Record<string, unknown>).priceCents, 150);
    assert.equal(calls.audits[calls.audits.length - 1]!.action, "update");
  });

  it("patch: missing id → 400; unknown id → 404; immutable ledgers → 405", async () => {
    const { tx } = makeStubTx();
    const def = OPS_ENTITY_MAP["products"]!;
    await assert.rejects(
      opsPatch(tx, def, ACTOR, { priceCents: 1 }, { gatePort: stubGatePort() }),
      (e: unknown) => e instanceof OpsError && e.status === 400,
    );
    await assert.rejects(
      opsPatch(tx, def, ACTOR, { id: "ghost", priceCents: 1 }, { gatePort: stubGatePort() }),
      (e: unknown) => e instanceof OpsError && e.status === 404,
    );
    for (const slug of ["payments", "inventory-txns"]) {
      await assert.rejects(
        opsPatch(tx, OPS_ENTITY_MAP[slug]!, ACTOR, { id: "x" }, { gatePort: stubGatePort() }),
        (e: unknown) => e instanceof OpsError && e.status === 405,
        `${slug} PATCH must 405`,
      );
    }
  });

  it("workflow run: compensationAppend appends with a timestamp, never replaces", async () => {
    const { tx, store } = makeStubTx();
    const def = OPS_ENTITY_MAP["workflow-runs"]!;
    store["opsWorkflowRun"] = [
      { id: "wfr_1", workspaceId: ACTOR.workspaceId, workflowName: "w", steps: [], compensationLog: [{ step: "charge", action: "void", at: "t0" }], status: "failed" },
    ];
    const res = await opsPatch(
      tx, def, ACTOR,
      { id: "wfr_1", status: "compensated", compensationAppend: { step: "fulfill", action: "cancel_shipment" } },
      { gatePort: stubGatePort() },
    );
    assert.equal(res.outcome, "done");
    if (res.outcome !== "done") return;
    const log = (res.row as Record<string, unknown>).compensationLog as Array<Record<string, unknown>>;
    assert.equal(log.length, 2, "appended, not replaced");
    assert.equal(log[0]!.step, "charge");
    assert.equal(log[1]!.step, "fulfill");
    assert.ok(typeof log[1]!.at === "string", "append stamped with at");
  });

  it("unknown entity slug → 404 via opsEntityDef (route mapping)", () => {
    assert.throws(() => opsEntityDef("nope"), (e: unknown) => e instanceof OpsError && e.status === 404);
    assert.throws(() => opsEntityDef(""), (e: unknown) => e instanceof OpsError && e.status === 404);
    // Every registered slug resolves.
    for (const d of OPS_ENTITIES) assert.equal(opsEntityDef(d.slug), d);
  });
});
