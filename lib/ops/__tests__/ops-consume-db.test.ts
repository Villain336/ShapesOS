// ShapesOS — Phase 2: the REAL ops approval consume path, on Postgres.
// The stub-tx suites model the guarded UPDATE in memory; this battery runs
// the production pieces end to end — phase14GatePort (getApproval), the
// status-guarded claim on composio_action_approvals inside the
// withWorkspaceScope transaction, and the ops write in that same
// transaction — including concurrent replays (Promise.all) that race on the
// approval row lock. Also: guarded PO receive, invoice idempotency-key
// upsert and the overdue sweep, all against the real tables.
// Run (DB suite): DATABASE_URL=… npx tsx --test lib/ops/__tests__/ops-consume-db.test.ts

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { OPS_ENTITY_MAP } from "../entities";
import { OpsError, opsCreate, opsPatch, type OpsActor } from "../doctype";
import { OpsGateError, opsBindingFor, phase14GatePort } from "../gate";
import { markOverdueInvoices } from "../invoices";

const WS = "p2e-ops-consume";
const ACTOR: OpsActor = { workspaceId: WS, userId: "user_p2e" };
const PAYMENTS = OPS_ENTITY_MAP["payments"]!;
const INVOICES = OPS_ENTITY_MAP["invoices"]!;
const POS = OPS_ENTITY_MAP["purchase-orders"]!;
const CHARGE = { kind: "charge", amountCents: 50_000, provider: "stripe", status: "succeeded" };

async function approvedApproval(slug: string, binding: Parameters<typeof opsBindingFor>[0]): Promise<string> {
  const row = await withWorkspaceScope(WS, (tx) =>
    tx.composioActionApproval.create({
      data: {
        workspaceId: WS,
        appKey: "ops",
        toolName: slug,
        riskTier: "medium",
        proposedArgs: opsBindingFor(binding) as object,
        plainSummary: "test",
        status: "approved",
        expiresAt: new Date(Date.now() + 3600_000),
      },
    }),
  );
  return row.id;
}

async function approvalStatus(id: string) {
  return withWorkspaceScope(WS, (tx) => tx.composioActionApproval.findFirst({ where: { id } }));
}

before(async () => {
  await prisma.$executeRaw`INSERT INTO workspaces (id, name, owner_user_id, updated_at)
    VALUES (${WS}, ${WS}, ${"test:" + WS}, now()) ON CONFLICT DO NOTHING`;
});

after(async () => {
  await prisma.$executeRaw`DELETE FROM workspaces WHERE id = ${WS}`;
  await prisma.$disconnect();
});

describe("ops approval consume (real Postgres)", () => {
  it("one approval, 4 concurrent replays → exactly one payment; approval executed", async () => {
    const approvalId = await approvedApproval("OPS_PAYMENT_RECORD_CHARGE", {
      entity: "payments",
      slug: "OPS_PAYMENT_RECORD_CHARGE",
      mutation: { ...CHARGE },
    });
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        withWorkspaceScope(WS, (tx) =>
          opsCreate(tx, PAYMENTS, ACTOR, { ...CHARGE, approvalId }, { gatePort: phase14GatePort }),
        ),
      ),
    );
    const ok = results.filter((r) => r.status === "fulfilled");
    const bad = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    assert.equal(ok.length, 1, "exactly one execution");
    for (const r of bad) {
      assert.ok(r.reason instanceof OpsGateError, String(r.reason));
      assert.match((r.reason as OpsGateError).code, /approval_replayed/);
    }
    const payments = await withWorkspaceScope(WS, (tx) => tx.opsPayment.count({ where: { workspaceId: WS } }));
    assert.equal(payments, 1);
    const a = await approvalStatus(approvalId);
    assert.equal(a?.status, "executed");
    assert.ok(
      (a?.auditTrail as Array<{ event: string }>).some((e) => e.event === "execution_claimed"),
      "claim recorded on the approval trail",
    );

    // A later sequential replay is refused at verification.
    await assert.rejects(
      withWorkspaceScope(WS, (tx) =>
        opsCreate(tx, PAYMENTS, ACTOR, { ...CHARGE, approvalId }, { gatePort: phase14GatePort }),
      ),
      (e: unknown) => e instanceof OpsGateError && e.code === "approval_replayed",
    );
  });

  it("a write that fails after the claim rolls the claim back (approval not burned)", async () => {
    const body = { ...CHARGE, orderId: "missing-order" };
    const approvalId = await approvedApproval("OPS_PAYMENT_RECORD_CHARGE", {
      entity: "payments",
      slug: "OPS_PAYMENT_RECORD_CHARGE",
      mutation: { ...body },
    });
    await assert.rejects(
      withWorkspaceScope(WS, (tx) =>
        opsCreate(tx, PAYMENTS, ACTOR, { ...body, approvalId }, { gatePort: phase14GatePort }),
      ),
    );
    const a = await approvalStatus(approvalId);
    assert.equal(a?.status, "approved", "FK failure rolled back the consume");
  });
});

describe("ops integrity on the real tables", () => {
  it("two concurrent PO receives restock exactly once", async () => {
    const product = await withWorkspaceScope(WS, (tx) =>
      tx.opsProduct.create({ data: { workspaceId: WS, name: "Widget", sku: `W-${Date.now()}`, priceCents: 100, stockQty: 0 } }),
    );
    const po = await withWorkspaceScope(WS, (tx) =>
      tx.opsPurchaseOrder.create({
        data: {
          workspaceId: WS,
          status: "sent",
          sentAt: new Date(),
          lineItems: [{ productId: product.id, name: "Widget", qty: 7, priceCents: 100 }],
          subtotalCents: 700,
          taxCents: 0,
          totalCents: 700,
        },
      }),
    );
    const results = await Promise.allSettled([
      withWorkspaceScope(WS, (tx) => opsPatch(tx, POS, ACTOR, { id: po.id, status: "received" })),
      withWorkspaceScope(WS, (tx) => opsPatch(tx, POS, ACTOR, { id: po.id, status: "received" })),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const rej = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    assert.ok(rej.reason instanceof OpsError && rej.reason.status === 409, String(rej.reason));
    const after = await withWorkspaceScope(WS, (tx) => tx.opsProduct.findFirst({ where: { id: product.id } }));
    assert.equal(after?.stockQty, 7, "restocked once");
    const txns = await withWorkspaceScope(WS, (tx) => tx.opsInventoryTxn.count({ where: { productId: product.id } }));
    assert.equal(txns, 1);
  });

  it("concurrent invoice creates with one idempotency key → one invoice, no error", async () => {
    const key = `idem-${Date.now()}`;
    const body = { lineItems: [{ description: "x", qty: 1, priceCents: 1000 }], idempotencyKey: key };
    const rs = await Promise.all(
      Array.from({ length: 4 }, () => withWorkspaceScope(WS, (tx) => opsCreate(tx, INVOICES, ACTOR, body))),
    );
    assert.equal(new Set(rs.map((r) => String((r as { row?: Record<string, unknown> }).row?.id))).size, 1);
    const n = await withWorkspaceScope(WS, (tx) => tx.opsInvoice.count({ where: { workspaceId: WS, idempotencyKey: key } }));
    assert.equal(n, 1);
    const again = await withWorkspaceScope(WS, (tx) => opsCreate(tx, INVOICES, ACTOR, body));
    assert.equal((again as { action: string }).action, "idempotent_replay");
  });

  it("overdue sweep flips sent past-due invoices only, guarded on status", async () => {
    const past = new Date(Date.now() - 86_400_000);
    const mk = (status: "sent" | "paid") =>
      withWorkspaceScope(WS, (tx) =>
        tx.opsInvoice.create({ data: { workspaceId: WS, status, lineItems: [], taxCents: 0, totalCents: 1, dueAt: past } }),
      );
    const sent = await mk("sent");
    const paid = await mk("paid");
    const res = await withWorkspaceScope(WS, (tx) => markOverdueInvoices(tx, ACTOR));
    assert.ok(res.ids.includes(sent.id));
    assert.ok(!res.ids.includes(paid.id));
    const p = await withWorkspaceScope(WS, (tx) => tx.opsInvoice.findFirst({ where: { id: paid.id } }));
    assert.equal(p?.status, "paid");
  });
});
