// ShapesOS — Phase 21B (WS=drive): the agent's Drive tools through the REAL gates
// (executeTool), against Postgres as the least-privilege app role.
//   - a run writes only inside /agents/<runId> and the folders the person attached;
//     look-alike prefixes, other runs, ".." and other people's homes are refused
//   - tier by effect: save (new) Tier 1; replace / move / trash Tier 2, never auto;
//     trashing many Tier 3; reads Tier 0
//   - the person's own rights still apply (a run never has more than its person)
//   - every change reports what it touched, and "Undo this agent run" puts it back
//     (and refuses to destroy someone's later edits)
// Run: DATABASE_URL=<app role url> npx tsx --test lib/drive/__tests__/agent-tools-db.test.ts
// Listed in scripts/test/db-tests.txt.

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "p21b-agent-"));
process.env.MARKETR_STORAGE = "local";
process.env.MARKETR_STORAGE_DIR = DIR;
delete process.env.DEPLOYMENT_MODE;
delete process.env.CLAMAV_HOST;

import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { executeTool, type ChatToolCall } from "@/lib/chat/tool-exec";
import { TOOL_ACTION, getTool, type ToolContext } from "@/lib/chat/tools";
import { createAgentRun } from "@/lib/agents/runs/service";
import { evaluateTier } from "@/lib/orchestrator/authority";
import { decideAutoApproval, NEVER_AUTO_ACTIONS } from "@/lib/automation/policy";
import { executeUndo, loadUndoPlan, type UndoActor } from "@/lib/timemachine/undo";
import { writeFile } from "@/lib/filesystem/service";
import { listFileVersions, overwriteFile } from "@/lib/filesystem/versions";
import { createFolderAs } from "@/lib/drive/ops";
import { attachFolderToRun } from "@/lib/drive/run-folders";
import { DRIVE_TOOLS } from "@/lib/drive/tools";
import { resetStorageAdapterForTests } from "@/lib/filesystem/storage";

const RUN = randomUUID().slice(0, 8);
const WS = `p21t-${RUN}`;
const ED = `p21t-ed-${RUN}`;
const OTHER = `p21t-other-${RUN}`;
const ADM = `p21t-adm-${RUN}`;
const VIEW = `p21t-view-${RUN}`;
let projectId = "";
let r1 = "";
const ed = { workspaceId: WS, userId: ED, role: "editor" as const };

const text = (s: string) => Buffer.from(s, "utf8");

async function call(ctx: ToolContext, tool: string, args: Record<string, unknown>, confirmed = true) {
  const c: ChatToolCall = { tool, args, status: "executed" };
  const r = await executeTool({ ...ctx, confirmed }, tool, args, c);
  return { r: r!, c };
}

before(async () => {
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
  projectId = (await prisma.project.create({ data: { workspaceId: WS, domain: `drive-${RUN}.test` } })).id;
  await createFolderAs(ed, "/shared/Reports");
  await createFolderAs(ed, "/shared/Other");
  await createFolderAs(ed, `/home/${ED}/Private`);
  r1 = (await createAgentRun({ workspaceId: WS, kind: "chat", startedBy: ED })).id;
  await attachFolderToRun(ed, r1, "/shared/Reports");
  await attachFolderToRun(ed, r1, `/home/${ED}/Private`);
});
after(async () => {
  await new Promise((r) => setTimeout(r, 300));
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.$disconnect();
  rmSync(DIR, { recursive: true, force: true });
});

const ctxFor = (runId: string, userId = ED, role: ToolContext["role"] = "editor"): ToolContext => ({ workspaceId: WS, projectId, userId, role, confirmed: true, runId });

describe("run folder grants", () => {
  it("only the run's starter (or an admin) attaches a folder, and only one the person can write to", async () => {
    await assert.rejects(() => attachFolderToRun({ workspaceId: WS, userId: OTHER, role: "editor" }, r1, "/shared/Other"), /Only the person who started/);
    await assert.rejects(() => attachFolderToRun(ed, r1, `/home/${OTHER}/Stuff`), (e: unknown) => (e as { status?: number }).status === 404);
    await assert.rejects(() => attachFolderToRun(ed, r1, `/agents/${r1}`), /can't be attached/);
    const res = await attachFolderToRun({ workspaceId: WS, userId: ADM, role: "admin" }, r1, "/shared/Reports");
    assert.deepEqual(res.folders, ["/shared/Reports", `/home/${ED}/Private`], "attaching twice is one folder");
  });
});

describe("where a run may write", () => {
  it("saves new files in its own workspace and in attached folders", async () => {
    for (const path of [`/agents/${r1}/summary.md`, "/shared/Reports/q3.md", `/home/${ED}/Private/notes.txt`]) {
      const { r, c } = await call(ctxFor(r1), "save_drive_file", { path, content: "hello from the agent" });
      assert.equal(c.status, "executed", path);
      assert.match(r.summary, /^Saved /, path);
      assert.equal(r.touched?.[0]?.op, "create");
    }
  });

  it("refuses everything else: other folders, look-alike prefixes, other runs, .., other people's homes", async () => {
    for (const path of ["/shared/Other/x.md", "/shared/Reports2/x.md", `/agents/${r1}0/x.md`, "/agents/someone-else/x.md", `/home/${OTHER}/x.md`, "/shared/Reports/../Other/x.md", "/files/x.md"]) {
      const { r } = await call(ctxFor(r1), "save_drive_file", { path, content: "nope" });
      assert.match(r.summary, /outside the folders this run was given|must be a Drive file path/, path);
      assert.equal(await prisma.workspaceFile.count({ where: { workspaceId: WS, logicalPath: { endsWith: "/x.md" } } }), 0, `${path} wrote nothing`);
    }
  });

  it("saving never changes an existing file: it points to replace_drive_file", async () => {
    const { r } = await call(ctxFor(r1), "save_drive_file", { path: "/shared/Reports/q3.md", content: "second" });
    assert.match(r.summary, /already exists[\s\S]*replace_drive_file/);
    const row = await prisma.workspaceFile.findFirstOrThrow({ where: { workspaceId: WS, logicalPath: "/shared/Reports/q3.md" } });
    assert.equal(row.version, 1);
  });

  it("a run with no folders attached still has its own workspace, and a chat turn gets a per-person one", async () => {
    const bare = (await createAgentRun({ workspaceId: WS, kind: "chat", startedBy: ED })).id;
    assert.match((await call(ctxFor(bare), "save_drive_file", { path: `/agents/${bare}/a.md`, content: "x" })).r.summary, /^Saved/);
    assert.match((await call(ctxFor(bare), "save_drive_file", { path: "/shared/Reports/z.md", content: "x" })).r.summary, /outside the folders/);
    const chatCtx: ToolContext = { workspaceId: WS, projectId, userId: ED, role: "editor", confirmed: true };
    assert.match((await call(chatCtx, "save_drive_file", { path: `/agents/chat-${ED}/c.md`, content: "x" })).r.summary, /^Saved/);
  });

  it("the person's own rights still apply: a folder they can only view cannot be written by their run", async () => {
    const f = await prisma.workspaceFolder.findFirstOrThrow({ where: { workspaceId: WS, path: "/shared/Other" } }).catch(async () => (await withWorkspaceScope(WS, (tx) => tx.workspaceFolder.findFirstOrThrow({ where: { workspaceId: WS, path: "/shared/Other" } }))));
    await withWorkspaceScope(WS, (tx) => tx.workspaceFolderAcl.create({ data: { workspaceId: WS, folderId: f.id, userId: ED, role: "viewer", grantedBy: ADM } }));
    const run = (await createAgentRun({ workspaceId: WS, kind: "chat", startedBy: ED })).id;
    // The folder was attached while the person could still write; the narrowing came later.
    await withWorkspaceScope(WS, (tx) => tx.agentRunFolder.create({ data: { workspaceId: WS, runId: run, folderPath: "/shared/Other", attachedBy: ED } }));
    const { r } = await call(ctxFor(run), "save_drive_file", { path: "/shared/Other/y.md", content: "x" });
    assert.match(r.summary, /doesn't allow adding files/);
  });
});

describe("tier by effect", () => {
  const defOf = (n: string) => getTool(n)!;
  const ON = { smallActionThresholdCents: 10000, automationAllows: true, defaultCurrency: "USD" } as never;
  const tier = (n: string) => evaluateTier({ kind: TOOL_ACTION[n]!, description: `${n}: ${defOf(n).description}` }, ON);

  it("registers every Drive tool with an action and a deliberate tier", () => {
    assert.deepEqual(DRIVE_TOOLS.map((t) => t.name), ["list_drive_folder", "read_drive_file", "save_drive_file", "replace_drive_file", "move_drive_file", "trash_drive_file", "trash_many_drive_files", "mount_drive_folder", "sync_drive_folder"]);
    assert.equal(tier("mount_drive_folder"), 0);
    assert.equal(tier("sync_drive_folder"), 1);
    for (const t of DRIVE_TOOLS) assert.ok(getTool(t.name), t.name);
    assert.equal(tier("save_drive_file"), 1);
    for (const n of ["replace_drive_file", "move_drive_file", "trash_drive_file"]) assert.equal(tier(n), 2, n);
    assert.equal(tier("trash_many_drive_files"), 3);
    assert.equal(evaluateTier({ kind: "read_agent_file", description: `read_drive_file: ${defOf("read_drive_file").description}` }, ON), 0);
  });

  it("an auto rule lets a NEW file save, but replace / move / trash / trash-many always ask", () => {
    const rule = (action: string) => [{ agentKey: "*", action, behavior: "auto" as const, thresholdCents: null }];
    for (const n of ["save_drive_file"]) {
      const a = TOOL_ACTION[n]!;
      assert.equal(decideAutoApproval(rule(a), { agentKey: "lead", action: a, description: `${n}: ${defOf(n).description}` }).auto, true, n);
    }
    for (const n of ["replace_drive_file", "move_drive_file", "trash_drive_file", "trash_many_drive_files"]) {
      const a = TOOL_ACTION[n]!;
      const d = decideAutoApproval(rule(a), { agentKey: "lead", action: a, description: `${n}: ${defOf(n).description}` });
      assert.equal(d.auto, false, `${n} must never run on a rule`);
      assert.equal(d.offerAuto, false, `${n} must never be offered auto`);
    }
    for (const a of ["replace_agent_file", "move_agent_file", "trash_agent_file"]) assert.ok(NEVER_AUTO_ACTIONS.has(a), a);
  });

  it("without the person's yes, replace does nothing", async () => {
    const before = await prisma.workspaceFile.findFirstOrThrow({ where: { workspaceId: WS, logicalPath: "/shared/Reports/q3.md" } });
    const { c } = await call(ctxFor(r1), "replace_drive_file", { path: "/shared/Reports/q3.md", content: "sneaky" }, false);
    assert.equal(c.status, "pending_confirmation");
    const after = await prisma.workspaceFile.findFirstOrThrow({ where: { id: before.id } });
    assert.equal(after.version, before.version);
  });

  it("a viewer's run cannot write at all", async () => {
    const vrun = (await createAgentRun({ workspaceId: WS, kind: "chat", startedBy: VIEW })).id;
    const { c } = await call(ctxFor(vrun, VIEW, "viewer"), "save_drive_file", { path: `/agents/${vrun}/a.md`, content: "x" });
    assert.equal(c.status, "skipped_role");
  });
});

describe("replace, move, trash", () => {
  it("replace keeps the earlier version; move stays inside the grant; trash is the Trash", async () => {
    const rep = await call(ctxFor(r1), "replace_drive_file", { path: "/shared/Reports/q3.md", content: "revised" });
    assert.match(rep.r.summary, /^Replaced .*now version 2/);
    const file = await prisma.workspaceFile.findFirstOrThrow({ where: { workspaceId: WS, logicalPath: "/shared/Reports/q3.md" } });
    assert.deepEqual((await listFileVersions(WS, file.id))!.map((v) => v.version), [2, 1]);
    assert.match((await call(ctxFor(r1), "replace_drive_file", { path: "/shared/Reports/nope.md", content: "x" })).r.summary, /No file at/);
    const mv = await call(ctxFor(r1), "move_drive_file", { from: "/shared/Reports/q3.md", to: "/shared/Reports/q3-final.md" });
    assert.match(mv.r.summary, /^Moved /);
    assert.match((await call(ctxFor(r1), "move_drive_file", { from: "/shared/Reports/q3-final.md", to: "/shared/Other/q3.md" })).r.summary, /destination is outside/);
    const tr = await call(ctxFor(r1), "trash_drive_file", { path: "/shared/Reports/q3-final.md" });
    assert.match(tr.r.summary, /to the Trash/);
    assert.ok((await prisma.workspaceFile.findFirstOrThrow({ where: { id: file.id } })).trashedAt);
  });

  it("trashing many at once needs 5 or more and the Tier-3 gate; fewer go through trash_drive_file", async () => {
    for (let i = 0; i < 5; i++) await call(ctxFor(r1), "save_drive_file", { path: `/shared/Reports/bulk${i}.txt`, content: `b${i}` });
    assert.match((await call(ctxFor(r1), "trash_many_drive_files", { paths: ["/shared/Reports/bulk0.txt", "/shared/Reports/bulk1.txt"] })).r.summary, /Give 5 to 50/);
    const paths = Array.from({ length: 5 }, (_, i) => `/shared/Reports/bulk${i}.txt`);
    const mixed = await call(ctxFor(r1), "trash_many_drive_files", { paths: [...paths.slice(0, 4), "/shared/Other/x.txt"] });
    assert.match(mixed.r.summary, /outside the folders/);
    assert.equal(await prisma.workspaceFile.count({ where: { workspaceId: WS, logicalPath: { startsWith: "/shared/Reports/bulk" }, trashedAt: null } }), 5, "one path outside the grant stops the whole call");
    const ok = await call(ctxFor(r1), "trash_many_drive_files", { paths });
    assert.match(ok.r.summary, /Moved 5 files to the Trash/);
    assert.equal(ok.r.touched?.length, 5);
  });
});

describe("read tools", () => {
  it("list and read stay inside the grant too", async () => {
    const ls = await call(ctxFor(r1), "list_drive_folder", { path: `/agents/${r1}` });
    assert.match(ls.r.summary, /summary\.md/);
    const rd = await call(ctxFor(r1), "read_drive_file", { path: `/agents/${r1}/summary.md` });
    assert.match(rd.r.summary, /hello from the agent/);
    assert.match((await call(ctxFor(r1), "read_drive_file", { path: "/shared/Other/anything.md" })).r.summary, /outside the folders/);
    assert.match((await call(ctxFor(r1), "list_drive_folder", { path: `/home/${OTHER}` })).r.summary, /outside the folders/);
  });
});

describe("Undo this agent run covers Drive files", () => {
  const undoActor: UndoActor = { workspaceId: WS, userId: ED, role: "editor" };
  it("puts back what a run created, replaced, moved and trashed — and leaves someone's later edit alone", async () => {
    // Existing files the run will change.
    const mk = async (p: string, body: string) => (await writeFile({ workspaceId: WS, logicalPath: p, kind: "file", bytes: text(body), createdBy: ED, mimeType: "text/plain" })).id;
    const b = await mk("/shared/Reports/b.txt", "b original");
    const cId = await mk("/shared/Reports/c.txt", "c original");
    const d = await mk("/shared/Reports/d.txt", "d original");
    const run = (await createAgentRun({ workspaceId: WS, kind: "chat", startedBy: ED })).id;
    await attachFolderToRun(ed, run, "/shared/Reports");
    const ctx = ctxFor(run);
    await call(ctx, "save_drive_file", { path: "/shared/Reports/a.txt", content: "a made by the agent" });
    await call(ctx, "save_drive_file", { path: "/shared/Reports/e.txt", content: "e made by the agent" });
    await call(ctx, "replace_drive_file", { path: "/shared/Reports/b.txt", content: "b changed by the agent" });
    await call(ctx, "move_drive_file", { from: "/shared/Reports/c.txt", to: "/shared/Reports/c-renamed.txt" });
    await call(ctx, "trash_drive_file", { path: "/shared/Reports/d.txt" });
    // A person edits e.txt after the agent made it.
    const eRow = await prisma.workspaceFile.findFirstOrThrow({ where: { workspaceId: WS, logicalPath: "/shared/Reports/e.txt" } });
    await overwriteFile({ workspaceId: WS, fileId: eRow.id, bytes: text("e edited by a person"), mimeType: "text/plain", userId: OTHER });
    await withWorkspaceScope(WS, (tx) => tx.agentRun.updateMany({ where: { id: run }, data: { status: "succeeded", endedAt: new Date() } }));

    const plan = await loadUndoPlan(undoActor, run);
    assert.deepEqual(plan.items.map((i) => i.kind).sort(), ["drive_create", "drive_create", "drive_move", "drive_trash", "drive_update"]);
    assert.ok(plan.items.every((i) => i.revertible));

    const res = await executeUndo(undoActor, run, { confirmed: true });
    const by = (k: string) => res.outcomes.filter((o) => o.kind === k);
    assert.equal(res.outcomes.filter((o) => o.result === "reverted").length, 4);
    const failed = res.outcomes.filter((o) => o.result === "failed");
    assert.equal(failed.length, 1);
    assert.equal(failed[0]!.kind, "drive_create");
    assert.match(failed[0]!.error ?? "", /Someone changed this file after the agent made it/);
    assert.equal(by("drive_move")[0]!.result, "reverted");

    const live = async (p: string) => prisma.workspaceFile.findFirst({ where: { workspaceId: WS, logicalPath: p, trashedAt: null } });
    assert.equal(await live("/shared/Reports/a.txt"), null, "the file the run created is in the Trash");
    assert.ok(await live("/shared/Reports/e.txt"), "the person's later edit was NOT destroyed");
    assert.ok(await live("/shared/Reports/c.txt"), "moved back");
    assert.equal(await live("/shared/Reports/c-renamed.txt"), null);
    assert.ok(await live("/shared/Reports/d.txt"), "restored from the Trash");
    const { readFileVersion } = await import("@/lib/filesystem/versions");
    const bRow = await prisma.workspaceFile.findFirstOrThrow({ where: { id: b } });
    assert.equal(bRow.version, 3, "the original came back as a NEW version; nothing was rewritten");
    assert.equal((await readFileVersion(WS, b, 3))!.bytes.toString(), "b original");
    assert.equal((await readFileVersion(WS, b, 2))!.bytes.toString(), "b changed by the agent", "history is kept");
    void cId;
    void d;
    // A second undo changes nothing.
    const again = await executeUndo(undoActor, run, { confirmed: true });
    assert.equal(again.outcomes.filter((o) => o.result === "reverted").length, 0);
  });
});
