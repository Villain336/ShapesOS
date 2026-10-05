// Marketr — Phase 17 slice 1 tests: RLS isolation battery for the ops tables.
// Integration: hits a scratch Postgres DB (ops_slice1_scratch) that carries
// the 20260930210600_phase17_ops_entities migration, exercising the same
// withWorkspaceScope code paths the DocType service uses. Mirrors
// lib/agents/runs/__tests__/runs-rls.test.ts.
// Run: DATABASE_URL="postgresql://<user>:<pw>@localhost:5433/ops_slice1_scratch" \
//        npx tsx --test lib/ops/__tests__/ops-rls.test.ts
// Requires the phase-17 ops migration applied to the DB (see the slice notes).

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope, countWithoutScope } from "@/lib/substrate/memory/rls";
import { OPS_ENTITY_MAP } from "../entities";
import { opsCreate, type OpsActor } from "../doctype";

const WS_A = "17s1-ws-a";
const WS_B = "17s1-ws-b";

// Workspaces are managed with raw SQL so the battery stays independent of the
// prisma Workspace model's relations.
async function createWorkspace(id: string) {
  // Targets the fully migrated schema (scripts/db/migrate.sh).
  await prisma.$executeRaw`INSERT INTO workspaces (id, name, owner_user_id, updated_at)
    VALUES (${id}, ${id}, ${"test:" + id}, now()) ON CONFLICT DO NOTHING`;
}

async function deleteWorkspace(id: string) {
  await prisma.$executeRaw`DELETE FROM workspaces WHERE id = ${id}`;
}

before(async () => {
  for (const id of [WS_A, WS_B]) await createWorkspace(id);
});

after(async () => {
  for (const id of [WS_A, WS_B]) await deleteWorkspace(id);
  await prisma.$disconnect();
});

const TABLES = [
  "ops_products",
  "ops_orders",
  "ops_payments",
  "ops_promotions",
  "ops_invoices",
  "ops_inventory_txns",
  "ops_projects",
  "ops_workflow_runs",
  "ops_audit_events",
];

describe("ops RLS isolation (scratch DB)", () => {
  it("isolates products: A writes, A reads, B sees nothing", async () => {
    const created = await withWorkspaceScope(WS_A, (tx) =>
      tx.opsProduct.create({
        data: { workspaceId: WS_A, name: "Retainer", sku: "RET-A", priceCents: 50000 },
      }),
    );
    assert.ok(created.id);

    const seenA = await withWorkspaceScope(WS_A, (tx) =>
      tx.opsProduct.findMany({ where: { workspaceId: WS_A } }),
    );
    assert.ok(seenA.some((p) => p.id === created.id));

    const seenB = await withWorkspaceScope(WS_B, (tx) =>
      tx.opsProduct.findMany({ where: { workspaceId: WS_A } }),
    );
    assert.equal(seenB.length, 0, "workspace B must not see A's products");

    const seenBOwn = await withWorkspaceScope(WS_B, (tx) =>
      tx.opsProduct.findMany({ where: { workspaceId: WS_B } }),
    );
    assert.equal(seenBOwn.length, 0);
  });

  it("is invisible without the GUC (fail-closed) on all nine tables", async () => {
    // Seed one row per table in WS_A first (products needed for the txn FK).
    await withWorkspaceScope(WS_A, async (tx) => {
      const p = await tx.opsProduct.create({
        data: { workspaceId: WS_A, name: "Seed", sku: "SEED-1", priceCents: 100 },
      });
      await tx.opsInventoryTxn.create({
        data: { workspaceId: WS_A, productId: p.id, delta: 5, reason: "restock" },
      });
      await tx.opsOrder.create({
        data: { workspaceId: WS_A, lineItems: [], subtotalCents: 0, taxCents: 0, totalCents: 0 },
      });
      await tx.opsPayment.create({ data: { workspaceId: WS_A, kind: "charge", amountCents: 100 } });
      await tx.opsPromotion.create({ data: { workspaceId: WS_A, code: "SEED10" } });
      await tx.opsInvoice.create({
        data: { workspaceId: WS_A, lineItems: [], taxCents: 0, totalCents: 0 },
      });
      await tx.opsProject.create({ data: { workspaceId: WS_A, name: "Seed project" } });
      await tx.opsWorkflowRun.create({ data: { workspaceId: WS_A, workflowName: "seed" } });
      await tx.opsAuditEvent.create({
        data: { workspaceId: WS_A, entity: "products", action: "list", actor: "seed", summary: "seed" },
      });
    });
    for (const t of TABLES) {
      assert.equal(await countWithoutScope(t), 0, `${t}: unscoped count must be 0 (FORCE RLS)`);
    }
  });

  it("blocks cross-workspace INSERT (RLS WITH CHECK)", async () => {
    await assert.rejects(
      withWorkspaceScope(WS_A, (tx) =>
        tx.opsInvoice.create({
          data: {
            workspaceId: WS_B, // lying about the tenant
            lineItems: [],
            taxCents: 0,
            totalCents: 0,
          },
        }),
      ),
      "cross-workspace invoice INSERT must be rejected by RLS",
    );
    await assert.rejects(
      withWorkspaceScope(WS_A, (tx) =>
        tx.opsPayment.create({
          data: { workspaceId: WS_B, kind: "charge", amountCents: 1 },
        }),
      ),
      "cross-workspace payment INSERT must be rejected by RLS",
    );
  });

  it("makes unscoped UPDATE a no-op under FORCE RLS", async () => {
    const inv = await withWorkspaceScope(WS_A, (tx) =>
      tx.opsInvoice.create({
        data: { workspaceId: WS_A, lineItems: [], taxCents: 0, totalCents: 900 },
      }),
    );
    const touched = await prisma.opsInvoice.updateMany({
      where: { id: inv.id },
      data: { status: "cancelled" },
    });
    assert.equal(touched.count, 0, "unscoped UPDATE must touch zero rows");
    const still = await withWorkspaceScope(WS_A, (tx) =>
      tx.opsInvoice.findFirst({ where: { id: inv.id } }),
    );
    assert.equal(still!.status, "draft");
  });

  it("audit events are tenant-isolated", async () => {
    await withWorkspaceScope(WS_A, (tx) =>
      tx.opsAuditEvent.create({
        data: { workspaceId: WS_A, entity: "invoices", action: "create", actor: "u", summary: "s" },
      }),
    );
    const fromB = await withWorkspaceScope(WS_B, (tx) =>
      tx.opsAuditEvent.findMany({ where: { workspaceId: WS_A } }),
    );
    assert.equal(fromB.length, 0, "workspace B must not see A's audit trail");
  });

  it("service-level: inventory txn decrements stock atomically, scoped to the workspace", async () => {
    const actor: OpsActor = { workspaceId: WS_A, userId: "agent:test" };
    const product = await withWorkspaceScope(WS_A, (tx) =>
      tx.opsProduct.create({
        data: { workspaceId: WS_A, name: "Widget", sku: "W-SVC", priceCents: 2500, stockQty: 10 },
      }),
    );
    const def = OPS_ENTITY_MAP["inventory-txns"]!;
    const res = await withWorkspaceScope(WS_A, (tx) =>
      opsCreate(tx, def, actor, { productId: product.id, delta: -3, reason: "sale" }),
    );
    assert.equal(res.outcome, "done");
    const after = await withWorkspaceScope(WS_A, (tx) =>
      tx.opsProduct.findFirst({ where: { id: product.id } }),
    );
    assert.equal(after!.stockQty, 7, "stock decremented exactly once");

    // The txn row is invisible from workspace B.
    const txnsB = await withWorkspaceScope(WS_B, (tx) =>
      tx.opsInventoryTxn.findMany({ where: { productId: product.id } }),
    );
    assert.equal(txnsB.length, 0);

    // ...and B cannot move A's stock: the product lookup misses under B's
    // scope, so the service 404s before writing anything.
    const actorB: OpsActor = { workspaceId: WS_B, userId: "agent:test" };
    await assert.rejects(
      withWorkspaceScope(WS_B, (tx) =>
        opsCreate(tx, def, actorB, { productId: product.id, delta: -1, reason: "sale" }),
      ),
      /not found in workspace/,
      "cross-workspace stock move must fail",
    );
    const still = await withWorkspaceScope(WS_A, (tx) =>
      tx.opsProduct.findFirst({ where: { id: product.id } }),
    );
    assert.equal(still!.stockQty, 7, "failed cross-workspace move changed nothing");
  });
});
