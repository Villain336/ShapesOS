// ShapesOS Phase 10 (ops-core): tasks + timesheets on real Postgres — tasks
// RLS, assignees must be workspace members, timesheet approval, and
// "invoice unbilled time" creating real lines exactly once.
// Run as the app role (scripts/test/db-tests.txt):
//   DATABASE_URL=<app role url> npx tsx --test lib/ops/__tests__/p10-projects-db.test.ts

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { OPS_ENTITY_MAP } from "../entities";
import { OpsError, opsCreate, type OpsActor } from "../doctype";
import { logTimeEntry } from "../projects";
import { decideTimesheet, invoiceUnbilledTime } from "../timesheets";

const WS_A = "p10prj-ws-a";
const WS_B = "p10prj-ws-b";
const ANN = "user-p10prj-ann";
const BOB = "user-p10prj-bob";
const A: OpsActor = { workspaceId: WS_A, userId: ANN };
const def = (slug: string) => OPS_ENTITY_MAP[slug]!;
const inA = <T>(fn: Parameters<typeof withWorkspaceScope<T>>[1]) => withWorkspaceScope(WS_A, fn);

let projectId = "";

before(async () => {
  for (const id of [WS_A, WS_B]) {
    await prisma.$executeRaw`DELETE FROM workspaces WHERE id = ${id}`;
    await prisma.$executeRaw`INSERT INTO workspaces (id, name, owner_user_id, updated_at) VALUES (${id}, ${id}, ${"test:" + id}, now())`;
  }
  await prisma.workspaceMember.createMany({
    data: [
      { workspaceId: WS_A, userId: ANN, name: "Ann", role: "owner" },
      { workspaceId: WS_A, userId: BOB, name: "Bob", role: "editor" },
    ],
  });
  const p = await inA((tx) => opsCreate(tx, def("projects"), A, { name: "Website", hourlyRateCents: 12000 }));
  projectId = String((p as { row: Record<string, unknown> }).row.id);
});

after(async () => {
  for (const id of [WS_A, WS_B]) await prisma.$executeRaw`DELETE FROM workspaces WHERE id = ${id}`;
  await prisma.$disconnect();
});

describe("p10 projects (real Postgres, app role)", () => {
  it("tasks: assignee must be a workspace member; RLS isolates", async () => {
    const t = await inA((tx) => opsCreate(tx, def("tasks"), A, { projectId, title: "Design", assigneeId: BOB }));
    assert.equal(t.outcome, "done");
    await assert.rejects(
      inA((tx) => opsCreate(tx, def("tasks"), A, { projectId, title: "X", assigneeId: "stranger" })),
      (e: unknown) => e instanceof OpsError && e.status === 422,
    );
    const seenB = await withWorkspaceScope(WS_B, (tx) => tx.opsTask.count({ where: { workspaceId: WS_A } }));
    assert.equal(seenB, 0);
    const raw = await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*)::bigint AS n FROM ops_tasks`;
    assert.equal(Number(raw[0]!.n), 0, "no GUC → zero rows");
  });

  it("approval gates billing; invoicing creates real lines exactly once", async () => {
    const e1 = await inA((tx) => logTimeEntry(tx, A, projectId, { minutes: 90, description: "Wireframes" }));
    const e2 = await inA((tx) => logTimeEntry(tx, A, projectId, { minutes: 60, userId: BOB, rateCents: 9000 }));
    const e3 = await inA((tx) => logTimeEntry(tx, A, projectId, { minutes: 30, userId: BOB, billable: false }));
    assert.equal(e1.userId, ANN, "defaults to the acting user");

    // Nothing approved yet → nothing to bill.
    await assert.rejects(inA((tx) => invoiceUnbilledTime(tx, A, projectId)), (e: unknown) => e instanceof OpsError && e.status === 422);

    const d = await inA((tx) => decideTimesheet(tx, A, [String(e1.id), String(e2.id), String(e3.id)], "approved"));
    assert.equal(d.updated, 3);
    const again = await inA((tx) => decideTimesheet(tx, A, [String(e1.id)], "rejected"));
    assert.deepEqual(again, { updated: 0, skipped: [String(e1.id)] }, "decisions are final");

    const r = await inA((tx) => invoiceUnbilledTime(tx, A, projectId));
    assert.equal(r.billedEntries, 2, "non-billable time is never invoiced");
    assert.equal(r.invoice.status, "draft");
    // Ann 90m @ $120 = $180; Bob 60m @ $90 = $90.
    assert.equal(r.invoice.totalCents, 18000 + 9000);
    assert.equal((r.invoice.lineItems as unknown[]).length, 2);
    const billed = await inA((tx) => tx.opsTimeEntry.findMany({ where: { projectId, billed: true } }));
    assert.equal(billed.length, 2);
    assert.ok(billed.every((b) => b.invoiceId === r.invoice.id));

    // A second run finds nothing left to bill — exactly once.
    await assert.rejects(inA((tx) => invoiceUnbilledTime(tx, A, projectId)), (e: unknown) => e instanceof OpsError && e.status === 422);
    assert.equal(await inA((tx) => tx.opsInvoice.count({ where: { workspaceId: WS_A } })), 1);
  });

  it("appends to an existing draft invoice", async () => {
    const e = await inA((tx) => logTimeEntry(tx, A, projectId, { minutes: 60 }));
    await inA((tx) => decideTimesheet(tx, A, [String(e.id)], "approved"));
    const inv = await inA((tx) => tx.opsInvoice.findFirst({ where: { workspaceId: WS_A } }));
    const r = await inA((tx) => invoiceUnbilledTime(tx, A, projectId, { invoiceId: inv!.id }));
    assert.equal(r.appended, true);
    assert.equal(r.invoice.id, inv!.id);
    assert.equal((r.invoice.lineItems as unknown[]).length, 3);
    assert.equal(r.invoice.totalCents, 27000 + 12000);
  });
});
