// ShapesOS Phase 10 (ops-core): the new OPS_TOOLS against real Postgres as
// the app role — CRM, projects, helpdesk and inventory tools write through
// the ops DocType service, reads are safe, groups/actions are mapped.
// The ticket-reply tool is not exercised here (it sends email; its path is
// covered with a stub provider in lib/ops/__tests__/p10-helpdesk-db.test.ts).
// Run: DATABASE_URL=<app role url> npx tsx --test lib/chat/__tests__/p10-ops-tools-db.test.ts

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { OPS_TOOLS } from "../ops-tools";
import { TOOL_ACTION, TOOL_GROUP, type ToolContext } from "../tools";

const WS = "p10tools-ws";
const USER = "user-p10tools";
const ctx = { projectId: "", workspaceId: WS, userId: USER, role: "owner", confirmed: true } as unknown as ToolContext;
const tool = (name: string) => {
  const t = OPS_TOOLS.find((x) => x.name === name);
  assert.ok(t, `${name} registered`);
  return t;
};
const run = async (name: string, args: Record<string, string> = {}) => tool(name).execute(ctx, args);
const P10 = [
  "ops_list_contacts", "ops_list_companies", "ops_list_deals", "ops_list_tickets", "ops_list_stock_by_location",
  "ops_create_contact", "ops_create_company", "ops_create_deal", "ops_move_deal_stage", "ops_convert_lead",
  "ops_create_task", "ops_log_time", "ops_create_ticket", "ops_reply_ticket", "ops_close_ticket",
  "ops_create_transfer", "ops_set_reorder_rule",
];

before(async () => {
  await prisma.$executeRaw`DELETE FROM workspaces WHERE id = ${WS}`;
  await prisma.$executeRaw`INSERT INTO workspaces (id, name, owner_user_id, updated_at) VALUES (${WS}, ${WS}, ${"test:" + WS}, now())`;
  await prisma.workspaceMember.create({ data: { workspaceId: WS, userId: USER, name: "Tool user", role: "owner" } });
  await prisma.pipeline.create({
    data: { workspaceId: WS, name: "Sales", isDefault: true, stages: [{ id: "new", label: "New" }, { id: "won", label: "Won" }, { id: "lost", label: "Lost" }] },
  });
});

after(async () => {
  await prisma.$executeRaw`DELETE FROM workspaces WHERE id = ${WS}`;
  await prisma.$disconnect();
});

describe("Phase 10 ops tools (real Postgres, app role)", () => {
  it("every new tool is registered with a group, and writes name an action", () => {
    for (const n of P10) {
      const t = tool(n);
      assert.ok(TOOL_GROUP[n], `${n} group`);
      if (t.kind === "safe") assert.equal(t.minRole, "viewer", n);
      else {
        assert.equal(t.kind, "publish", n);
        assert.equal(t.minRole, "editor", n);
        assert.ok(TOOL_ACTION[n], `${n} action`);
      }
    }
  });

  it("CRM: company → contact (auto-linked by domain) → deal → stage move", async () => {
    const co = await run("ops_create_company", { name: "Acme", domain: "acme.com" });
    const coId = String((co.details as Record<string, unknown>).id);
    const c = await run("ops_create_contact", { name: "Ann", email: "ann@acme.com" });
    assert.equal((c.details as Record<string, unknown>).companyId, coId);
    const d = await run("ops_create_deal", { title: "Acme rollout", valueCents: "250000", companyId: coId });
    const dealId = String((d.details as Record<string, unknown>).id);
    const moved = await run("ops_move_deal_stage", { dealId, stage: "won" });
    assert.equal((moved.details as Record<string, unknown>).status, "won");
    const listed = await run("ops_list_deals", { status: "won" });
    assert.equal(((listed.details as { rows: unknown[] }).rows).length, 1);
  });

  it("projects: create task, log time (pending approval)", async () => {
    const p = await withWorkspaceScope(WS, (tx) => tx.opsProject.create({ data: { workspaceId: WS, name: "Site" } }));
    const t = await run("ops_create_task", { projectId: p.id, title: "Wireframes", assigneeId: USER });
    assert.equal((t.details as Record<string, unknown>).assigneeId, USER);
    const l = await run("ops_log_time", { projectId: p.id, minutes: "45", description: "kickoff" });
    assert.equal((l.details as Record<string, unknown>).approvalStatus, "pending");
    await assert.rejects(run("ops_log_time", { projectId: p.id, minutes: "1.5" }), /whole number/);
  });

  it("helpdesk: open and close a ticket", async () => {
    const t = await run("ops_create_ticket", { subject: "Can't log in", requesterEmail: "cy@example.test", priority: "high" });
    const id = String((t.details as Record<string, unknown>).id);
    assert.equal((t.details as Record<string, unknown>).channel, "agent");
    const closed = await run("ops_close_ticket", { ticketId: id });
    assert.equal((closed.details as Record<string, unknown>).status, "solved");
  });

  it("inventory: draft a stock move, set a reorder rule twice (update, not duplicate), list stock", async () => {
    const ids = await withWorkspaceScope(WS, async (tx) => {
      const product = await tx.opsProduct.create({ data: { workspaceId: WS, name: "Widget", sku: "W-1", priceCents: 100 } });
      const wh = await tx.opsWarehouse.create({ data: { workspaceId: WS, name: "Main", code: "WH" } });
      const a = await tx.opsLocation.create({ data: { workspaceId: WS, warehouseId: wh.id, kind: "bin", code: "A", path: "WH/A" } });
      const b = await tx.opsLocation.create({ data: { workspaceId: WS, warehouseId: wh.id, kind: "bin", code: "B", path: "WH/B" } });
      return { product: product.id, wh: wh.id, a: a.id, b: b.id };
    });
    const tr = await run("ops_create_transfer", { fromLocationId: ids.a, toLocationId: ids.b, lines: JSON.stringify([{ productId: ids.product, qty: 2 }]) });
    assert.equal((tr.details as Record<string, unknown>).status, "draft");
    await run("ops_set_reorder_rule", { productId: ids.product, warehouseId: ids.wh, minQty: "2", maxQty: "10" });
    const again = await run("ops_set_reorder_rule", { productId: ids.product, warehouseId: ids.wh, minQty: "3", maxQty: "12" });
    assert.equal((again.details as Record<string, unknown>).minQty, 3);
    assert.equal(await withWorkspaceScope(WS, (tx) => tx.opsReorderRule.count({ where: { workspaceId: WS } })), 1);
    const stock = await run("ops_list_stock_by_location", { warehouseId: ids.wh });
    assert.match(stock.summary, /0 stock position/);
  });
});
