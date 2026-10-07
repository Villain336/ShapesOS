// ShapesOS — Phase 18.3 (WS=flow): "Undo this agent run" against real Postgres.
//   - a run (and its delegated sub-agent run) does real work through
//     executeTool — the gate chat uses — so the timeline records what each
//     call wrote: a note, a reminder, a share link, an ops ticket it opened
//     and then closed; plus a sent mail and a refund (labelled synthetic
//     events: no mail or money leaves this test)
//   - the plan classifies each: note / reminder / share link / ticket status
//     revertible; the created ticket, the sent mail and the refund listed as
//     "can't be undone" with the reason
//   - only the run's starter or an admin may undo; it needs confirmation;
//     another editor and a viewer are refused
//   - undo reverts exactly the revertible changes through each domain's own
//     path (note deleted, reminder removed, link revoked, ticket back to
//     open, the sub-agent's note too) and leaves money / sent / created
//     untouched; audited + on the run's timeline; a second undo is a no-op
// Run (as the least-privilege app role):
//   DATABASE_URL=… npx tsx --test lib/timemachine/__tests__/undo-db.test.ts
// Listed in scripts/test/db-tests.txt.

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { createAgentRun, appendAgentRunEvent } from "@/lib/agents/runs/service";
import { executeTool, type ChatToolCall } from "@/lib/chat/tool-exec";
import type { ToolContext } from "@/lib/chat/tools";
import { writeFile } from "@/lib/filesystem/service";
import { resetStorageAdapterForTests } from "@/lib/filesystem/storage";
import { executeUndo, irreversibleReason, loadUndoPlan, planUndo, type UndoActor } from "../undo";

const RUN = randomUUID().slice(0, 8);
const WS = `p183undo-${RUN}`;
const ADM = `p183undo-adm-${RUN}`;
const ED = `p183undo-ed-${RUN}`;
const OTHER = `p183undo-other-${RUN}`;
const VIEW = `p183undo-view-${RUN}`;
const BLOB_DIR = mkdtempSync(join(tmpdir(), "p183undo-"));
let projectId = "";
let runId = "";
let childId = "";
let ticketId = "";
let fileId = "";

async function call(ctx: ToolContext, tool: string, args: Record<string, unknown>) {
  const c: ChatToolCall = { tool, args, status: "executed" };
  const r = await executeTool(ctx, tool, args, c);
  assert.equal(c.status, "executed", `${tool}: ${c.resultSummary}`);
  return r!;
}

before(async () => {
  process.env.MARKETR_STORAGE_DIR = join(BLOB_DIR, "files");
  resetStorageAdapterForTests();
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.workspace.create({ data: { id: WS, name: WS, ownerUserId: ADM, plan: "agency" } });
  await prisma.workspaceMember.createMany({
    data: [
      { workspaceId: WS, userId: ADM, role: "admin" },
      { workspaceId: WS, userId: ED, role: "editor" },
      { workspaceId: WS, userId: OTHER, role: "editor" },
      { workspaceId: WS, userId: VIEW, role: "viewer" },
    ],
  });
  projectId = (await prisma.project.create({ data: { workspaceId: WS, domain: `undo-${RUN}.test` } })).id;
  fileId = (await writeFile({ workspaceId: WS, logicalPath: "/files/plan.txt", kind: "file", bytes: Buffer.from("plan"), mimeType: "text/plain", createdBy: ED, skipSafety: true })).id;
  const run = await createAgentRun({ workspaceId: WS, kind: "chat", startedBy: ED });
  const child = await createAgentRun({ workspaceId: WS, kind: "chat", startedBy: ED, parentRunId: run.id, agentKey: "researcher" });
  runId = run.id;
  childId = child.id;
  const ctx: ToolContext = { workspaceId: WS, projectId, userId: ED, role: "editor", confirmed: true, runId };
  await call(ctx, "create_note", { title: "Run notes", body: "What I found" });
  await call(ctx, "create_reminder", { title: "Follow up with Ana" });
  await call(ctx, "share_file_link", { file: fileId });
  const opened = await call(ctx, "ops_create_ticket", { subject: "Printer jam" });
  ticketId = String((opened.details as { id: string }).id);
  // A person triages it ("new" → "open"; "new" itself is not a status a patch may set).
  await withWorkspaceScope(WS, (tx) => tx.opsTicket.update({ where: { id: ticketId }, data: { status: "open" } }));
  await call(ctx, "ops_close_ticket", { ticketId, status: "solved" });
  await call({ ...ctx, runId: childId, agentKey: "researcher" }, "create_note", { body: "Sub-agent scratch" });
  // Synthetic (labelled): a sent mail and a refund — no external call is made here.
  await appendAgentRunEvent(WS, runId, { type: "agui", summary: "mail_send (synthetic)", payload: { kind: "tool_result", tool: "mail_send", status: "executed" } });
  await appendAgentRunEvent(WS, runId, { type: "agui", summary: "refund (synthetic)", payload: { kind: "tool_result", tool: "connector.stripe.create_refund", status: "executed" } });
  await withWorkspaceScope(WS, (tx) => tx.agentRun.updateMany({ where: { id: { in: [runId, childId] } }, data: { status: "succeeded", endedAt: new Date() } }));
});

after(async () => {
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.$disconnect();
  rmSync(BLOB_DIR, { recursive: true, force: true });
});

const ed: UndoActor = { workspaceId: WS, userId: ED, role: "editor" };
const adm: UndoActor = { workspaceId: WS, userId: ADM, role: "admin" };

describe("Undo this agent run (DB)", () => {
  it("pure: irreversible reasons and the planner", () => {
    assert.equal(irreversibleReason("mail_send", "publish"), "message");
    assert.equal(irreversibleReason("connector.stripe.create_refund", "publish"), "money");
    assert.equal(irreversibleReason("research_question", "spend"), "money");
    assert.equal(irreversibleReason("connector.hubspot.update_contact", "publish"), "external");
    assert.equal(irreversibleReason("create_note", "publish"), null);
    const plan = planUndo({
      runId: "r",
      runIds: ["r"],
      events: [
        { runId: "r", seq: 1, createdAt: new Date(), payload: { kind: "tool_result", tool: "get_keywords", status: "executed" } },
        { runId: "r", seq: 2, createdAt: new Date(), payload: { kind: "tool_result", tool: "weird_write", status: "executed" } },
        { runId: "r", seq: 3, createdAt: new Date(), payload: { kind: "tool_result", tool: "create_note", status: "pending_confirmation", touched: [{ kind: "note", id: "n", op: "create" }] } },
      ],
      sites: [{ id: "s1", siteId: "site", number: 3, status: "applied", backupId: "b1", runId: "r" }, { id: "s2", siteId: "site", number: 4, status: "discarded", backupId: null, runId: "r" }],
      toolKind: (n) => (n === "get_keywords" ? "safe" : "publish"),
    });
    assert.deepEqual(plan.items.map((i) => [i.kind, i.revertible, i.reason]), [["unknown", false, "unknown"], ["site_applied", true, null]]);
  });

  it("classifies the run's changes from its timeline (sub-agent included)", async () => {
    const plan = await loadUndoPlan(ed, runId);
    assert.deepEqual(plan.runIds.sort(), [runId, childId].sort());
    const kinds = plan.items.map((i) => `${i.kind}:${i.revertible}`).sort();
    assert.deepEqual(kinds, ["file_share:true", "message:false", "money:false", "note:true", "note:true", "ops_create:false", "ops_update:true", "reminder:true"].sort());
    assert.equal(plan.items.find((i) => i.kind === "ops_update")?.ref?.before?.status, "open", "the prior value is on the timeline");
    assert.equal(plan.items.find((i) => i.kind === "money")?.reason, "money");
    assert.equal(plan.items.find((i) => i.kind === "message")?.reason, "message");
    assert.equal(plan.canUndo, true);
  });

  it("only the starter or an admin, and only when confirmed", async () => {
    await assert.rejects(executeUndo({ workspaceId: WS, userId: OTHER, role: "editor" }, runId, { confirmed: true }), /Only the person who started/);
    await assert.rejects(executeUndo({ workspaceId: WS, userId: VIEW, role: "viewer" }, runId, { confirmed: true }), /Only the person who started/);
    await assert.rejects(executeUndo(ed, runId, { confirmed: false }), /confirmation/);
  });

  it("reverts exactly the revertible changes and leaves money / sent / created alone", async () => {
    const before = await withWorkspaceScope(WS, async (tx) => ({
      notes: await tx.univerDoc.count({ where: { workspaceId: WS, kind: "note" } }),
      reminders: await tx.opsTask.count({ where: { workspaceId: WS, projectId: null } }),
      tickets: await tx.opsTicket.count({ where: { workspaceId: WS } }),
    }));
    assert.deepEqual(before, { notes: 2, reminders: 1, tickets: 1 });
    const { outcomes } = await executeUndo(ed, runId, { confirmed: true });
    assert.equal(outcomes.filter((o) => o.result === "reverted").length, 5, JSON.stringify(outcomes));
    const after = await withWorkspaceScope(WS, async (tx) => ({
      notes: await tx.univerDoc.count({ where: { workspaceId: WS, kind: "note" } }),
      reminders: await tx.opsTask.count({ where: { workspaceId: WS, projectId: null } }),
      ticket: await tx.opsTicket.findFirstOrThrow({ where: { id: ticketId } }),
      link: await tx.workspaceFileShare.findFirstOrThrow({ where: { workspaceId: WS, fileId } }),
    }));
    assert.equal(after.notes, 0, "both notes (the lead's and the sub-agent's) deleted");
    assert.equal(after.reminders, 0);
    assert.equal(after.ticket.status, "open", "ticket back to its prior status; the ticket itself stays (created records are kept)");
    assert.ok(after.link.revokedAt, "share link revoked");
    const audit = await prisma.fileChangeLog.findFirst({ where: { workspaceId: WS, action: "agent_run_undone" } });
    assert.match(audit?.summary ?? "", /5 changes reverted, 0 failed, 3 can't be undone/);
    const ev = await withWorkspaceScope(WS, (tx) => tx.agentRunEvent.findFirst({ where: { runId, type: "note" }, orderBy: { seq: "desc" } }));
    assert.equal((ev?.payload as { kind?: string })?.kind, "undo");
    // A second undo finds nothing left to do.
    const again = await executeUndo(adm, runId, { confirmed: true });
    assert.ok(again.outcomes.every((o) => o.result === "already"), JSON.stringify(again.outcomes));
    assert.ok((await loadUndoPlan(ed, runId)).undoneAt, "the plan shows it was undone");
  });
});
