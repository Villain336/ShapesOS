// ShapesOS — Phase 18.2 (WS=comms) DB test: Reminders over OpsTask.
//   - a reminder is a project-less OpsTask assigned to its owner; only the
//     owner lists / edits / removes it (a teammate gets 404), and the generic
//     ops task list and PATCH never see it;
//   - completing a repeating reminder rolls it to the next occurrence;
//   - due → ONE reminder_due notification per occurrence through the
//     producers: held while the owner is in focus, not repeated by a second
//     sweep, a new occurrence notifies again;
//   - the agent tools: create_reminder waits for a person unless a rule says
//     auto (Tier 1), and is refused outside the task's grant.
// Real Postgres as the least-privilege app role.
// Run: DATABASE_URL=<app role> npx tsx --test lib/comms/__tests__/reminders-db.test.ts
// Listed in scripts/test/db-tests.txt.

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { ToolContext } from "@/lib/chat/tools";
import type { ChatToolCall } from "@/lib/chat/tool-exec";

const RUN = randomUUID().slice(0, 8);
const WS = `p182-rem-${RUN}`;
const ANA = `p182-ana-${RUN}`;
const BEN = `p182-ben-${RUN}`;

let prisma: typeof import("@/lib/prisma").prisma;
let rls: typeof import("@/lib/substrate/memory/rls");
let rem: typeof import("../reminders");
let sweep: typeof import("../sweep.server");
let focus: typeof import("@/lib/desktop/focus.server");

const scoped = <T,>(fn: (tx: import("@prisma/client").Prisma.TransactionClient) => Promise<T>) =>
  rls.withWorkspaceScope(WS, (tx) => fn(tx as import("@prisma/client").Prisma.TransactionClient));

async function cleanup() {
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.notification.deleteMany({ where: { userId: { in: [ANA, BEN] } } });
  await prisma.userDeskState.deleteMany({ where: { userId: { in: [ANA, BEN] } } });
}

before(async () => {
  ({ prisma } = await import("@/lib/prisma"));
  rls = await import("@/lib/substrate/memory/rls");
  rem = await import("../reminders");
  sweep = await import("../sweep.server");
  focus = await import("@/lib/desktop/focus.server");
  await cleanup();
  await prisma.workspace.create({ data: { id: WS, name: WS, ownerUserId: ANA } });
  await prisma.workspaceMember.createMany({
    data: [
      { workspaceId: WS, userId: ANA, role: "owner" },
      { workspaceId: WS, userId: BEN, role: "editor" },
    ],
  });
});

after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("Reminders are personal OpsTasks", () => {
  it("only the owner sees and changes them; the generic ops task list never does", async () => {
    const r = await scoped((tx) => rem.createReminder(tx, { workspaceId: WS, userId: ANA, title: "Call the bank" }));
    const row = await scoped((tx) => tx.opsTask.findUnique({ where: { id: r.id } }));
    assert.equal(row?.projectId, null);
    assert.equal(row?.assigneeId, ANA);
    assert.deepEqual((await scoped((tx) => rem.listReminders(tx, { workspaceId: WS, userId: ANA }))).map((x) => x.id), [r.id]);
    assert.deepEqual(await scoped((tx) => rem.listReminders(tx, { workspaceId: WS, userId: BEN })), []);
    await assert.rejects(scoped((tx) => rem.updateReminder(tx, { workspaceId: WS, userId: BEN, id: r.id, patch: { done: true } })), /not found/);
    await assert.rejects(scoped((tx) => rem.removeReminder(tx, { workspaceId: WS, userId: BEN, id: r.id })), /not found/);

    const { opsList, opsPatch } = await import("@/lib/ops/doctype");
    const { OPS_ENTITIES } = await import("@/lib/ops/entities");
    const def = OPS_ENTITIES.find((d) => d.slug === "tasks")!;
    const listed = await scoped((tx) => opsList(tx, def, { workspaceId: WS, userId: BEN, role: "editor" } as never));
    assert.ok(!listed.rows.some((x) => x.id === r.id), "not in the project task list");
    await assert.rejects(scoped((tx) => opsPatch(tx, def, { workspaceId: WS, userId: BEN, role: "editor" } as never, { id: r.id, title: "hijacked" })), /not found|tasks/i);
  });

  it("completing a repeating reminder rolls it to the next occurrence (in the owner's zone)", async () => {
    const due = new Date(Date.now() - 60 * 60 * 1000);
    const r = await scoped((tx) => rem.createReminder(tx, { workspaceId: WS, userId: ANA, title: "Stand-up notes", dueAt: due, repeat: "daily" }));
    const next = await scoped((tx) => rem.updateReminder(tx, { workspaceId: WS, userId: ANA, id: r.id, patch: { done: true }, timeZone: "Europe/Madrid" }));
    assert.equal(next.done, false, "stays open");
    assert.ok(next.completedAt);
    assert.ok(new Date(next.dueAt!).getTime() > Date.now(), "moved past now");
    const once = await scoped((tx) => rem.createReminder(tx, { workspaceId: WS, userId: ANA, title: "Renew passport" }));
    const doneOnce = await scoped((tx) => rem.updateReminder(tx, { workspaceId: WS, userId: ANA, id: once.id, patch: { done: true } }));
    assert.equal(doneOnce.done, true);
    const reopened = await scoped((tx) => rem.updateReminder(tx, { workspaceId: WS, userId: ANA, id: once.id, patch: { done: false } }));
    assert.equal(reopened.done, false);
  });
});

describe("due reminders → one notification per occurrence", () => {
  it("held while the owner is in focus, never repeated, re-armed by a new due time", async () => {
    const dueAt = new Date(Date.now() - 5 * 60 * 1000);
    const r = await scoped((tx) => rem.createReminder(tx, { workspaceId: WS, userId: ANA, title: "Pay the invoice from Acme", dueAt }));
    await focus.startFocus(ANA, { minutes: 30 });
    const first = await sweep.sweepDueReminders({ workspaceIds: [WS] });
    assert.ok(first.notified >= 1, JSON.stringify(first));
    const rows = await prisma.notification.findMany({ where: { userId: ANA, kind: "reminder_due", sourceId: r.id } });
    assert.equal(rows.length, 1);
    assert.ok(rows[0]!.heldAt, "held under focus");
    assert.equal(rows[0]!.href, `/dashboard/reminders?reminder=${r.id}`);
    assert.equal(await prisma.notification.count({ where: { userId: BEN, kind: "reminder_due" } }), 0, "only the owner");

    await sweep.sweepDueReminders({ workspaceIds: [WS] });
    assert.equal(await prisma.notification.count({ where: { userId: ANA, kind: "reminder_due", sourceId: r.id } }), 1, "no duplicate");

    await focus.endFocus(ANA);
    const released = await prisma.notification.findFirst({ where: { userId: ANA, kind: "reminder_due", sourceId: r.id } });
    assert.equal(released?.heldAt, null, "delivered when focus ends");

    const moved = new Date(Date.now() - 60 * 1000);
    await scoped((tx) => rem.updateReminder(tx, { workspaceId: WS, userId: ANA, id: r.id, patch: { dueAt: moved } }));
    await sweep.sweepDueReminders({ workspaceIds: [WS] });
    assert.equal(await prisma.notification.count({ where: { userId: ANA, kind: "reminder_due", sourceId: r.id } }), 2, "a new occurrence notifies again");
  });
});

describe("the agent tools go through the tier gate", () => {
  const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
    projectId: `p182-noproject-${RUN}`,
    workspaceId: WS,
    userId: BEN,
    role: "editor",
    confirmed: false,
    agentKey: "scheduler",
    grant: ["workspace", "calendar"],
    ...over,
  });
  const call = (tool: string, args: Record<string, unknown>): ChatToolCall => ({ tool, args, status: "pending_confirmation" });

  it("create_reminder asks without a rule, runs under one (Tier 1), and is denied outside the grant", async () => {
    const { executeTool } = await import("@/lib/chat/tool-exec");
    const args = { title: "Send the deck", dueAt: new Date(Date.now() + 86_400_000).toISOString() };
    const asks = call("create_reminder", args);
    await executeTool(ctx(), "create_reminder", args, asks);
    assert.equal(asks.status, "pending_confirmation");
    assert.equal(asks.autoAction, "create_reminder", "offered: do this without asking");
    assert.equal(await scoped((tx) => tx.opsTask.count({ where: { workspaceId: WS, assigneeId: BEN } })), 0, "nothing written");

    await scoped((tx) => tx.automationSetting.create({ data: { workspaceId: WS, agentKey: "scheduler", action: "create_reminder", behavior: "auto", updatedBy: ANA } }));
    const runs = call("create_reminder", args);
    await executeTool(ctx(), "create_reminder", args, runs);
    assert.equal(runs.status, "executed", runs.resultSummary);
    assert.match(runs.autoApproved ?? "", /create_reminder rule/);
    const mine = await scoped((tx) => rem.listReminders(tx, { workspaceId: WS, userId: BEN }));
    assert.equal(mine.length, 1);
    assert.equal(mine[0]!.title, "Send the deck");

    const denied = call("create_reminder", args);
    await executeTool(ctx({ grant: ["workspace"] }), "create_reminder", args, denied);
    assert.equal(denied.status, "denied");

    const complete = call("complete_reminder", { reminderId: mine[0]!.id });
    await executeTool(ctx({ confirmed: true }), "complete_reminder", complete.args, complete);
    assert.equal(complete.status, "executed", complete.resultSummary);
    const list = call("list_reminders", { includeDone: true });
    await executeTool(ctx({ grant: ["workspace"] }), "list_reminders", list.args, list);
    assert.equal(list.status, "executed");
  });
});
