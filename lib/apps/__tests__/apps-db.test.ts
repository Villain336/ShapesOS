// ShapesOS — Phase 9 (apps), end to end against Postgres (as the app role):
//   1. Drafts and publishing: editors draft, only admins publish; viewers
//      never see drafts; publish snapshots a version.
//   2. Records: every write is a spec action, validated server-side
//      (types, required, relation targets, files); reads honour view roles.
//   3. Tiers: 1 asks first; 2 goes through the REAL ops/Phase 14 gate —
//      nothing is written before approval, the approval binds the exact
//      mutation, and it can't be replayed.
//   4. Version migration: records written under v1 stay readable after v2
//      drops a field and adds a required one; an edit upgrades them.
//   5. RLS: another workspace sees nothing; no GUC sees zero rows.
//   6. Agent tools through executeTool: writes ask, deletes always ask
//      (even with an auto-approve rule), drafts never publish, an
//      auto-approved tier-1 write escalates to an approval.
// Listed in scripts/test/db-tests.txt.
// Run: DATABASE_URL=… npx tsx --test lib/apps/__tests__/apps-db.test.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { countWithoutScope, withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { decideApproval } from "@/lib/integrations/actions/gate";
import { OpsGateError } from "@/lib/ops/gate";
import { executeTool, type ChatToolCall } from "@/lib/chat/tool-exec";
import type { ToolContext } from "@/lib/chat/tools";
import {
  AppError,
  createApp,
  getRecord,
  listApps,
  listRecords,
  loadApp,
  publishApp,
  runAppAction,
  saveDraft,
  type AppActor,
} from "../service";
import { __setAppToolsTestDeps, app_create_spec, app_upsert_record } from "../tools";
import type { MiniAppSpec } from "../spec";

const RUN = `p9a-${Date.now().toString(36)}`;
const WS_A = `${RUN}-a`;
const WS_B = `${RUN}-b`;
const OWNER = `${RUN}-owner`;
const APPROVER = `${RUN}-approver`;

const owner: AppActor = { workspaceId: WS_A, userId: OWNER, role: "owner" };
const admin: AppActor = { workspaceId: WS_A, userId: `${RUN}-admin`, role: "admin" };
const editor: AppActor = { workspaceId: WS_A, userId: `${RUN}-editor`, role: "editor" };
const viewer: AppActor = { workspaceId: WS_A, userId: `${RUN}-viewer`, role: "viewer" };
const outsider: AppActor = { workspaceId: WS_B, userId: `${RUN}-b-owner`, role: "owner" };

let projectId = "";
let fileId = "";
let workflowId = "";
let siteId = "";
let ticketId = "";

function spec(): MiniAppSpec {
  return {
    name: "Facilities",
    slug: "facilities",
    entities: [
      {
        key: "sites",
        label: "Site",
        fields: [{ key: "name", label: "Name", type: "text", required: true }],
      },
      {
        key: "tickets",
        label: "Ticket",
        titleField: "title",
        fields: [
          { key: "title", label: "Title", type: "text", required: true },
          { key: "status", label: "Status", type: "select", options: ["Open", "Closed"], required: true },
          { key: "cost", label: "Cost", type: "money", min: 0 },
          { key: "site", label: "Site", type: "relation", target: "sites" },
          { key: "photo", label: "Photo", type: "file" },
          { key: "notes", label: "Notes", type: "text", format: "multiline" },
        ],
      },
    ],
    views: [
      { key: "sites", label: "Sites", type: "table", entity: "sites" },
      { key: "open", label: "Open", type: "table", entity: "tickets", filters: [{ field: "status", op: "eq", value: "Open" }], sort: { field: "createdAt", dir: "asc" } },
      { key: "costly", label: "Costly", type: "table", entity: "tickets", filters: [{ field: "cost", op: "gte", value: 10000 }], minRole: "admin" },
      { key: "board", label: "Board", type: "kanban", entity: "tickets", groupBy: "status" },
    ],
    actions: [
      { key: "add_site", label: "Add site", type: "create_record", entity: "sites" },
      { key: "add", label: "Add ticket", type: "create_record", entity: "tickets" },
      { key: "edit", label: "Edit", type: "update_record", entity: "tickets" },
      { key: "close", label: "Close", type: "update_record", entity: "tickets", set: { status: "Closed" } },
      { key: "reopen", label: "Reopen", type: "update_record", entity: "tickets", set: { status: "Open" }, tier: 1, minRole: "admin" },
      { key: "reimburse", label: "Refund the contractor", type: "update_record", entity: "tickets", set: { status: "Closed" } },
      { key: "remove", label: "Delete", type: "delete_record", entity: "tickets" },
    ],
  };
}

async function rejects(p: Promise<unknown>, status: number, re?: RegExp) {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof AppError, `expected AppError, got ${String(e)}`);
    assert.equal(e.status, status, e.message);
    if (re) assert.match(e.message, re);
    return true;
  });
}

before(async () => {
  for (const id of [WS_A, WS_B]) await prisma.workspace.create({ data: { id, name: `P9 ${id}`, ownerUserId: id === WS_A ? OWNER : outsider.userId } });
  projectId = (await prisma.project.create({ data: { workspaceId: WS_A, domain: `${RUN}.example` } })).id;
  fileId = (
    await withWorkspaceScope(WS_A, (tx) =>
      tx.workspaceFile.create({
        data: { workspaceId: WS_A, logicalPath: "/files/apps/photo.png", storageKey: `${RUN}-key`, filename: "photo.png", mimeType: "image/png", sizeBytes: 3, kind: "file", createdBy: OWNER },
      }),
    )
  ).id;
  workflowId = (await prisma.workflow.create({ data: { projectId, name: "Dispatch", status: "active", enabled: true } })).id;
});

after(async () => {
  __setAppToolsTestDeps(null);
  for (const id of [WS_A, WS_B]) await prisma.workspace.deleteMany({ where: { id } });
  await prisma.$disconnect();
});

describe("mini-apps (DB)", () => {
  it("drafts: editors create, viewers can't; drafts are hidden from viewers; only admins publish", async () => {
    await rejects(createApp(viewer, { spec: spec() }), 403);
    await createApp(editor, { spec: spec() });
    await rejects(createApp(editor, { spec: spec() }), 409, /already exists/);
    await rejects(createApp(editor, { spec: { ...spec(), entities: [] } }), 400, /not valid/);

    assert.equal((await listApps(viewer)).length, 0, "viewers don't see drafts");
    await rejects(loadApp(viewer, "facilities"), 404);
    assert.equal((await listApps(editor))[0]?.published, false);
    await rejects(runAppAction(editor, "facilities", { action: "add", data: { title: "x", status: "Open" } }), 409, /isn't published/);

    await rejects(publishApp(editor, "facilities"), 403);
    assert.deepEqual(await publishApp(admin, "facilities"), { version: 1 });
    const app = await loadApp(viewer, "facilities");
    assert.equal(app.version, 1);
    assert.equal(app.draftSpec, null, "viewers never get the draft");
    const versions = await withWorkspaceScope(WS_A, (tx) => tx.miniAppVersion.count({ where: { workspaceId: WS_A } }));
    assert.equal(versions, 1);
  });

  it("publish refuses unknown tools / tools outside toolGroups / foreign workflows", async () => {
    const bad = spec();
    bad.actions.push({ key: "kw", label: "Keywords", type: "call_tool", tool: "research_keywords" });
    await saveDraft(editor, "facilities", bad);
    await rejects(publishApp(admin, "facilities"), 400, /web group/);
    bad.actions[bad.actions.length - 1] = { key: "wf", label: "Dispatch", type: "run_workflow", workflowId: "nope" };
    await saveDraft(editor, "facilities", bad);
    await rejects(publishApp(admin, "facilities"), 400, /no such workflow/);
    await rejects(saveDraft(editor, "facilities", { ...spec(), slug: "other" }), 400, /fixed/);
    await saveDraft(editor, "facilities", spec());
  });

  it("records: validated server-side, relations and files must exist, roles per action", async () => {
    const site = await runAppAction(editor, "facilities", { action: "add_site", data: { name: "HQ" } });
    assert.equal(site.outcome, "done");
    siteId = site.outcome === "done" ? site.record!.id : "";

    await rejects(runAppAction(editor, "facilities", { action: "add", data: { title: "Leak" } }), 400, /Status is required/);
    await rejects(runAppAction(editor, "facilities", { action: "add", data: { title: "Leak", status: "Open", cost: 1.5 } }), 400, /whole cents/);
    await rejects(runAppAction(editor, "facilities", { action: "add", data: { title: "Leak", status: "Open", site: "missing" } }), 400, /no such sites record/);
    await rejects(runAppAction(editor, "facilities", { action: "add", data: { title: "Leak", status: "Open", photo: "missing" } }), 400, /no such file/);
    await rejects(runAppAction(viewer, "facilities", { action: "add", data: { title: "Leak", status: "Open" } }), 403);

    const t = await runAppAction(editor, "facilities", { action: "add", data: { title: "Leak", status: "Open", cost: 25000, site: siteId, photo: fileId, notes: "Under the sink" } });
    assert.equal(t.outcome, "done");
    ticketId = t.outcome === "done" ? t.record!.id : "";
    await runAppAction(editor, "facilities", { action: "add", data: { title: "Bulb", status: "Open", cost: 500 } });

    // A site record can't satisfy a ticket action.
    await rejects(runAppAction(editor, "facilities", { action: "close", recordId: siteId }), 400, /acts on tickets/);
    // Admin-only action.
    await rejects(runAppAction(editor, "facilities", { action: "reopen", recordId: ticketId, confirmed: true }), 403);
  });

  it("reads honour view roles and apply view filters + sort", async () => {
    const open = await listRecords(viewer, "facilities", { view: "open" });
    assert.deepEqual(open.rows.map((r) => r.data.title), ["Leak", "Bulb"]);
    await rejects(listRecords(viewer, "facilities", { view: "costly" }), 403);
    const costly = await listRecords(admin, "facilities", { view: "costly" });
    assert.deepEqual(costly.rows.map((r) => r.data.title), ["Leak"]);
    const searched = await listRecords(viewer, "facilities", { entity: "tickets", q: "bulb" });
    assert.equal(searched.matched, 1);
    await rejects(listRecords(viewer, "facilities", { entity: "tickets", filters: [{ field: "nope", op: "eq", value: 1 }] }), 400);
  });

  it("tier 0 runs, tier 1 asks first, then runs when confirmed", async () => {
    const closed = await runAppAction(editor, "facilities", { action: "close", recordId: ticketId });
    assert.equal(closed.outcome, "done");
    assert.equal(closed.outcome === "done" ? closed.record?.data.status : null, "Closed");

    const ask = await runAppAction(admin, "facilities", { action: "reopen", recordId: ticketId });
    assert.equal(ask.outcome, "confirm_required");
    assert.equal((await getRecord(admin, "facilities", ticketId)).record.data.status, "Closed", "nothing ran");
    const ran = await runAppAction(admin, "facilities", { action: "reopen", recordId: ticketId, confirmed: true });
    assert.equal(ran.outcome, "done");
  });

  it("tier 2 goes through the real gate: propose, nothing written, approve, execute once, binding enforced", async () => {
    const proposed = await runAppAction(editor, "facilities", { action: "reimburse", recordId: ticketId, confirmed: true });
    assert.equal(proposed.outcome, "approval_required");
    const approvalId = proposed.outcome === "approval_required" ? proposed.approval.id : "";
    assert.equal((await getRecord(editor, "facilities", ticketId)).record.data.status, "Open", "nothing written before approval");

    await assert.rejects(
      runAppAction(editor, "facilities", { action: "reimburse", recordId: ticketId, approvalId }),
      (e: unknown) => e instanceof OpsGateError && e.code === "approval_not_approved",
    );
    await decideApproval({ workspaceId: WS_A, approvalId, decision: "approved", decidedBy: APPROVER });

    // A different record can't ride on this approval.
    const other = await runAppAction(editor, "facilities", { action: "add", data: { title: "Door", status: "Open" } });
    const otherId = other.outcome === "done" ? other.record!.id : "";
    await assert.rejects(
      runAppAction(editor, "facilities", { action: "reimburse", recordId: otherId, approvalId }),
      (e: unknown) => e instanceof OpsGateError && e.code === "binding_mismatch",
    );

    const done = await runAppAction(editor, "facilities", { action: "reimburse", recordId: ticketId, approvalId });
    assert.equal(done.outcome, "done");
    assert.equal((await getRecord(editor, "facilities", ticketId)).record.data.status, "Closed");
    await assert.rejects(
      runAppAction(editor, "facilities", { action: "reimburse", recordId: ticketId, approvalId }),
      (e: unknown) => e instanceof OpsGateError && e.code === "approval_replayed",
    );
    const audits = await withWorkspaceScope(WS_A, (tx) => tx.opsAuditEvent.findMany({ where: { workspaceId: WS_A, entity: "app:facilities" }, select: { action: true } }));
    const actions = new Set(audits.map((a) => a.action));
    for (const a of ["app_create", "app_publish", "record_create", "record_update", "gate_proposed"]) assert.ok(actions.has(a), `audited ${a}`);
  });

  it("run_workflow queues a run of a workflow in this workspace (asks first)", async () => {
    const s = spec();
    s.actions.push({ key: "dispatch", label: "Dispatch", type: "run_workflow", workflowId, entity: "tickets" });
    await saveDraft(editor, "facilities", s);
    assert.deepEqual(await publishApp(admin, "facilities"), { version: 2 });
    assert.equal((await runAppAction(editor, "facilities", { action: "dispatch", recordId: ticketId })).outcome, "confirm_required");
    const r = await runAppAction(editor, "facilities", { action: "dispatch", recordId: ticketId, confirmed: true });
    assert.equal(r.outcome, "done");
    const runId = r.outcome === "done" ? r.workflowRunId! : "";
    const run = await prisma.workflowRun.findUnique({ where: { id: runId } });
    assert.equal(run?.status, "queued");
    assert.equal(run?.createdBy, editor.userId);
  });

  it("call_tool runs through the tool runner with the app's grant; the tool's kind floors the tier", async () => {
    const s = spec();
    s.toolGroups = ["content"];
    s.actions.push({ key: "brief", label: "Draft a brief", type: "call_tool", tool: "create_content_draft", args: { keyword: "{{record.title}}", note: "ticket {{record.id}}" }, entity: "tickets" });
    await saveDraft(editor, "facilities", s);
    await publishApp(admin, "facilities");
    const seen: Array<{ ctx: ToolContext; tool: string; args: Record<string, unknown> }> = [];
    const deps = {
      toolKind: async () => "spend",
      toolRunner: async (ctx: ToolContext, tool: string, args: Record<string, unknown>) => {
        seen.push({ ctx, tool, args });
        return { status: "executed", summary: "draft created (stub runner)" };
      },
    };
    assert.equal((await runAppAction(editor, "facilities", { action: "brief", recordId: ticketId }, deps)).outcome, "confirm_required");
    const r = await runAppAction(editor, "facilities", { action: "brief", recordId: ticketId, confirmed: true }, deps);
    assert.equal(r.outcome, "done");
    assert.equal(seen[0]!.tool, "create_content_draft");
    assert.deepEqual(seen[0]!.args, { keyword: "Leak", note: `ticket ${ticketId}` });
    assert.deepEqual(seen[0]!.ctx.grant, ["workspace", "content"]);
    assert.equal(seen[0]!.ctx.projectId, projectId);
    assert.equal(seen[0]!.ctx.confirmed, true);
  });

  it("version migration: v1 records stay readable after a field is dropped and a required one added", async () => {
    const before = (await getRecord(editor, "facilities", ticketId)).record;
    assert.equal(before.specVersion, 1);
    const v = spec();
    const tickets = v.entities[1]!;
    tickets.fields = tickets.fields.filter((f) => f.key !== "notes");
    tickets.fields.push({ key: "priority", label: "Priority", type: "select", options: ["Low", "High"], required: true });
    await saveDraft(editor, "facilities", v);
    const { version } = await publishApp(admin, "facilities");

    const listed = await listRecords(viewer, "facilities", { entity: "tickets" });
    const old = listed.rows.find((r) => r.id === ticketId)!;
    assert.equal(old.data.notes, "Under the sink", "the dropped field's value is still there");
    const detail = await getRecord(viewer, "facilities", ticketId);
    assert.equal(detail.record.specVersion, 1);
    assert.ok(detail.writtenWith?.entities[1]!.fields.some((f) => f.key === "notes"), "rendered with its own version's spec");

    await rejects(runAppAction(editor, "facilities", { action: "edit", recordId: ticketId, data: { title: "Leak (kitchen)" } }), 400, /Priority is required/);
    await rejects(runAppAction(editor, "facilities", { action: "edit", recordId: ticketId, data: { notes: "x" } }), 400, /not a field/);
    const up = await runAppAction(editor, "facilities", { action: "edit", recordId: ticketId, data: { priority: "High" } });
    assert.equal(up.outcome, "done");
    const after = (await getRecord(editor, "facilities", ticketId)).record;
    assert.equal(after.specVersion, version);
    assert.equal(after.data.notes, "Under the sink", "older-version keys are carried, not lost");
    assert.equal(after.data.priority, "High");
  });

  it("RLS: another workspace sees nothing, and no GUC sees zero rows", async () => {
    await rejects(loadApp(outsider, "facilities"), 404);
    await rejects(listRecords(outsider, "facilities", { entity: "tickets" }), 404);
    assert.equal((await listApps(outsider)).length, 0);
    const crossRead = await withWorkspaceScope(WS_B, (tx) => tx.miniAppRecord.count({ where: { workspaceId: WS_A } }));
    assert.equal(crossRead, 0, "RLS hides A's rows from B even with an explicit filter");
    for (const t of ["mini_apps", "mini_app_versions", "mini_app_records"]) assert.equal(await countWithoutScope(t), 0, t);
    await assert.rejects(
      withWorkspaceScope(WS_B, (tx) =>
        tx.miniAppRecord.create({ data: { workspaceId: WS_A, appId: "x", entity: "tickets", data: {}, specVersion: 1, createdBy: "attacker" } }),
      ),
      "WITH CHECK refuses writing into another workspace",
    );
  });

  it("delete: asks first, then deletes", async () => {
    const id = (await listRecords(editor, "facilities", { entity: "tickets", q: "bulb" })).rows[0]!.id;
    assert.equal((await runAppAction(editor, "facilities", { action: "remove", recordId: id })).outcome, "confirm_required");
    const r = await runAppAction(editor, "facilities", { action: "remove", recordId: id, confirmed: true });
    assert.equal(r.outcome === "done" ? r.deletedId : null, id);
    await rejects(getRecord(editor, "facilities", id), 404);
  });
});

describe("mini-app agent tools (DB, through executeTool)", () => {
  function ctx(over: Partial<ToolContext> = {}): ToolContext {
    return { projectId, workspaceId: WS_A, userId: editor.userId, role: "editor", confirmed: false, agentKey: "lead", grant: ["workspace", "ops"], ...over };
  }
  function call(tool: string, args: Record<string, unknown>): ChatToolCall {
    return { tool, args, status: "pending_confirmation" };
  }

  it("writes wait for a person unless a rule says auto (Phase 14); deletes ask even with an auto-approve rule", async () => {
    // A (misconfigured) every-agent "auto" row for deletes — it may never let
    // a delete run without a person — and (Phase 14) one for writes, which
    // is honoured: a Tier-2 write runs under it.
    await withWorkspaceScope(WS_A, async (tx) => {
      for (const action of ["delete_app_record", "write_app_record"]) {
        await tx.automationSetting.create({ data: { workspaceId: WS_A, agentKey: "*", action, behavior: "auto", updatedBy: OWNER } });
      }
    });
    const up = call("app_upsert_record", { app: "facilities", entity: "tickets", data: JSON.stringify({ title: "Agent", status: "Open", priority: "Low" }) });
    await executeTool(ctx(), "app_upsert_record", up.args, up);
    assert.equal(up.status, "executed", up.resultSummary);
    assert.match(up.autoApproved ?? "", /auto-approved by the write_app_record rule for every agent/);
    // Without the rule the write waits for a person.
    await withWorkspaceScope(WS_A, (tx) => tx.automationSetting.deleteMany({ where: { workspaceId: WS_A, action: "write_app_record" } }));
    const asks = call("app_upsert_record", up.args);
    await executeTool(ctx(), "app_upsert_record", up.args, asks);
    assert.equal(asks.status, "pending_confirmation");
    const del = call("app_delete_record", { app: "facilities", entity: "tickets", recordId: ticketId });
    await executeTool(ctx(), "app_delete_record", del.args, del);
    assert.equal(del.status, "pending_confirmation", "destructive always asks");
    assert.ok((await getRecord(editor, "facilities", ticketId)).record, "nothing deleted");

    const yes = call("app_upsert_record", up.args);
    await executeTool(ctx({ confirmed: true }), "app_upsert_record", up.args, yes);
    assert.equal(yes.status, "executed", yes.resultSummary);
    const denied = call("app_upsert_record", up.args);
    await executeTool(ctx({ confirmed: true, grant: ["workspace"] }), "app_upsert_record", up.args, denied);
    assert.equal(denied.status, "denied", "outside the ops grant");
  });

  it("an unconfirmed (auto-approved) tier-1 agent write escalates to an approval", async () => {
    const s = spec();
    s.entities[1]!.fields.push({ key: "priority", label: "Priority", type: "select", options: ["Low", "High"] });
    s.actions = s.actions.map((a) => (a.key === "add" ? { ...a, tier: 1 as const } : a));
    await saveDraft(editor, "facilities", s);
    await publishApp(admin, "facilities");
    const r = await app_upsert_record.execute(ctx({ confirmed: false }), { app: "facilities", entity: "tickets", data: { title: "Auto", status: "Open" } });
    assert.match(r.summary, /Approval required/);
    assert.ok((r.details as { approvalId?: string }).approvalId);
    const r2 = await app_upsert_record.execute(ctx({ confirmed: true }), { app: "facilities", entity: "tickets", data: { title: "Confirmed", status: "Open" } });
    assert.match(r2.summary, /Created ticket/);
  });

  it("app_create_spec writes a draft only (never publishes) and reports validation errors", async () => {
    const s = { ...spec(), slug: "agent-built", name: "Agent built" };
    const r = await app_create_spec.execute(ctx({ confirmed: true }), { spec: JSON.stringify(s) });
    assert.match(r.summary, /draft created/);
    const app = await loadApp(editor, "agent-built");
    assert.equal(app.published, false);
    assert.equal(app.spec, null);
    await assert.rejects(app_create_spec.execute(ctx({ confirmed: true }), { spec: JSON.stringify({ ...s, views: [] }) }), /not valid/);
    const r2 = await app_create_spec.execute(ctx({ confirmed: true }), { spec: JSON.stringify({ ...s, description: "v2 draft" }) });
    assert.match(r2.summary, /draft updated/);
    assert.equal((await loadApp(editor, "agent-built")).published, false);
  });
});
