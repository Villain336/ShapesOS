// ShapesOS — Phase 18.3 (WS=flow): Time Machine snapshots against real
// Postgres + the local blob store.
//   - a seeded workspace (project, workflow + nodes + edges, skill +
//     schedule, notes with record links, reminders, a file with bytes, an
//     agent run with events, a self-referencing row) is snapshotted: the
//     export is in object storage, the manifest row has per-table counts
//   - admins only; one at a time; FORCE RLS on workspace_snapshots
//   - restore goes into a NEW workspace: for every restored table the row
//     count matches the snapshot; ids are re-keyed and references follow;
//     the file's bytes are copied to a new key; automations come back off;
//     in-flight runs are cancelled; skipped tables are listed with reasons;
//     the source workspace is untouched; both workspaces audit it
//   - retention keeps the newest N; the schedule says when one is due
// Run (as the least-privilege app role):
//   DATABASE_URL=… npx tsx --test lib/timemachine/__tests__/snapshots-db.test.ts
// Listed in scripts/test/db-tests.txt.

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope, countWithoutScope } from "@/lib/substrate/memory/rls";
import { createNote } from "@/lib/notes/service";
import { createReminder } from "@/lib/comms/reminders";
import { writeFile, readFile } from "@/lib/filesystem/service";
import { resetStorageAdapterForTests } from "@/lib/filesystem/storage";
import { createAgentRun } from "@/lib/agents/runs/service";
import { snapshotDue, snapshotsToPrune, applyRetention, listSnapshots } from "../snapshots";
import { countRows, skipReason } from "../restore";
import { tmDeleteSnapshot, tmOverview, tmRestore, tmSaveSettings, tmTakeSnapshot, type TimeMachineActor } from "../service";

const RUN = randomUUID().slice(0, 8);
const WS = `p183tm-${RUN}`;
const ADM = `p183tm-adm-${RUN}`;
const ED = `p183tm-ed-${RUN}`;
const adm: TimeMachineActor = { workspaceId: WS, userId: ADM, role: "admin" };
const ed: TimeMachineActor = { workspaceId: WS, userId: ED, role: "editor" };
const BLOB_DIR = mkdtempSync(join(tmpdir(), "p183tm-blobs-"));
const restoredWorkspaces: string[] = [];
let projectId = "";
let fileId = "";

before(async () => {
  process.env.MARKETR_BLOB_DIR = BLOB_DIR;
  process.env.MARKETR_STORAGE_DIR = join(BLOB_DIR, "files");
  resetStorageAdapterForTests();
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.workspace.create({ data: { id: WS, name: `Acme ${RUN}`, ownerUserId: ADM } });
  await prisma.workspaceMember.createMany({
    data: [
      { workspaceId: WS, userId: ADM, role: "admin", email: `adm-${RUN}@example.test` },
      { workspaceId: WS, userId: ED, role: "editor", email: `ed-${RUN}@example.test` },
    ],
  });
  const project = await prisma.project.create({ data: { workspaceId: WS, domain: `acme-${RUN}.test` } });
  projectId = project.id;
  const wf = await prisma.workflow.create({ data: { projectId, name: "Weekly audit", status: "active", enabled: true, schedule: "0 9 * * 1", createdBy: ADM } });
  const n1 = await prisma.workflowNode.create({ data: { workflowId: wf.id, kind: "trigger", type: "schedule", label: "Monday", config: { cron: "0 9 * * 1" }, positionX: 0, positionY: 0 } });
  const n2 = await prisma.workflowNode.create({ data: { workflowId: wf.id, kind: "action", type: "send_alert", label: "Tell me", config: { title: "Hi" }, positionX: 200, positionY: 0 } });
  await prisma.workflowEdge.create({ data: { workflowId: wf.id, sourceNodeId: n1.id, targetNodeId: n2.id } });
  await prisma.workflowRun.create({ data: { workflowId: wf.id, projectId, status: "running", triggerKind: "manual", createdBy: ADM } });
  await withWorkspaceScope(WS, async (tx) => {
    const skill = await tx.skill.create({ data: { workspaceId: WS, name: "Ticket digest", slug: `digest-${RUN}`, description: "d", source: "upload", skillMd: "# d", declaredTools: [], trustTier: "built_in" } });
    await tx.scheduledSkill.create({ data: { workspaceId: WS, skillId: skill.id, triggerType: "cron", cronExpr: "0 9 * * 1", createdBy: ADM, approvalMode: "supervised", status: "active" } });
    await createReminder(tx, { workspaceId: WS, userId: ED, title: "Call Ana", dueAt: null, repeat: null });
  });
  await createNote({ workspaceId: WS, createdBy: ED, title: "Kickoff", body: "Agenda\n- budget", links: [{ kind: "project", id: projectId, label: "acme" }], shareState: "workspace" });
  const f = await writeFile({ workspaceId: WS, logicalPath: "/files/brief.txt", kind: "file", bytes: Buffer.from(`brief ${RUN}`), mimeType: "text/plain", createdBy: ED, skipSafety: true });
  fileId = f.id;
  const run = await createAgentRun({ workspaceId: WS, kind: "chat", startedBy: ADM } as never);
  const child = await createAgentRun({ workspaceId: WS, kind: "chat", startedBy: ADM, parentRunId: run.id } as never);
  void child;
});

after(async () => {
  await prisma.workspace.deleteMany({ where: { id: { in: [WS, ...restoredWorkspaces] } } });
  await prisma.$disconnect();
  rmSync(BLOB_DIR, { recursive: true, force: true });
});

describe("Time Machine snapshots (DB)", () => {
  let snapId = "";

  it("pure: due schedule and retention", () => {
    const now = new Date("2026-10-06T12:00:00Z");
    assert.equal(snapshotDue("off", null, now), false);
    assert.equal(snapshotDue("daily", null, now), true);
    assert.equal(snapshotDue("daily", new Date("2026-10-06T00:00:00Z"), now), false);
    assert.equal(snapshotDue("daily", new Date("2026-10-05T12:00:00Z"), now), true);
    assert.equal(snapshotDue("weekly", new Date("2026-10-01T12:00:00Z"), now), false);
    const rows = [1, 2, 3, 4].map((d) => ({ id: String(d), status: "ready", createdAt: new Date(2026, 9, d) }));
    assert.deepEqual(snapshotsToPrune([...rows, { id: "x", status: "failed", createdAt: new Date(2026, 9, 9) }], 2).map((r) => r.id), ["2", "1"]);
    assert.equal(skipReason("workspace_members"), "members");
    assert.equal(skipReason("agent_jobs"), "queues");
    assert.equal(skipReason("usage_events"), "billing");
    assert.equal(skipReason("projects"), null);
  });

  it("admins only: an editor can't take, list, restore or change snapshots", async () => {
    await assert.rejects(tmTakeSnapshot(ed), /admins/);
    await assert.rejects(tmOverview(ed), /admins/);
    await assert.rejects(tmSaveSettings(ed, { schedule: "daily" }), /admins/);
    await assert.rejects(tmRestore(ed, "x"), /admins/);
  });

  it("takes a snapshot: the export in object storage, per-table counts in the manifest row, FORCE RLS", async () => {
    const s = await tmTakeSnapshot(adm);
    snapId = s.id;
    assert.equal(s.status, "ready");
    assert.ok(s.sizeBytes > 0);
    assert.equal(s.tables.projects, 1);
    assert.equal(s.tables.workflow_nodes, 2);
    assert.equal(s.tables.workflow_edges, 1);
    assert.equal(s.tables.univer_docs, 1);
    assert.equal(s.tables.workspace_files, 1);
    assert.ok((s.tables.agent_runs ?? 0) >= 2);
    assert.ok(s.rowCount >= 10);
    assert.equal(await countWithoutScope("workspace_snapshots"), 0, "no GUC → zero rows");
    const audit = await prisma.fileChangeLog.findFirst({ where: { workspaceId: WS, action: "snapshot_created" } });
    assert.match(audit?.summary ?? "", new RegExp(s.id));
  });

  it("restores into a NEW workspace with matching counts; ids re-keyed, files copied, automations off", async (t) => {
    const report = await tmRestore(adm, snapId, `Acme restored ${RUN}`);
    t.diagnostic(`restored completely: ${report.tables.filter((x) => x.notRestored === 0).map((x) => `${x.table}=${x.restored}`).join(", ")}`);
    t.diagnostic(`not fully restored: ${JSON.stringify(report.tables.filter((x) => x.notRestored > 0))}`);
    t.diagnostic(`skipped on purpose: ${JSON.stringify(report.skipped)}; never in a snapshot: ${report.neverIncluded.join(", ")}`);
    restoredWorkspaces.push(report.workspaceId);
    assert.notEqual(report.workspaceId, WS);
    const restored = report.tables.map((t) => t.table);
    const countsNew = await countRows(report.workspaceId, restored);
    const snap = (await listSnapshots(WS)).find((x) => x.id === snapId)!;
    const complete = report.tables.filter((t) => t.notRestored === 0);
    for (const t of complete) {
      // The new workspace's own audit rows (created, restored) come on top of the restored ones.
      if (t.table === "file_change_log") assert.equal(countsNew[t.table], snap.tables[t.table]! + 2, "audit log: restored rows + created + restored");
      else assert.equal(countsNew[t.table], snap.tables[t.table], `rows in ${t.table}`);
    }
    for (const must of ["projects", "workflows", "workflow_nodes", "workflow_edges", "skills", "scheduled_skills", "univer_docs", "note_links", "ops_tasks", "workspace_files", "agent_runs"]) {
      assert.ok(complete.some((t) => t.table === must), `${must} restored completely (${JSON.stringify(report.tables.find((x) => x.table === must))})`);
    }
    // Skipped tables are listed with a reason, never silently dropped.
    assert.ok(report.skipped.some((s) => s.table === "workspace_members" && s.reason === "members"));
    // Ids are new, references follow.
    const newProject = await prisma.project.findFirstOrThrow({ where: { workspaceId: report.workspaceId } });
    assert.notEqual(newProject.id, projectId);
    const newWf = await prisma.workflow.findFirstOrThrow({ where: { projectId: newProject.id }, include: { nodes: true, edges: true } });
    assert.equal(newWf.nodes.length, 2);
    assert.ok(newWf.edges.every((e) => newWf.nodes.some((n) => n.id === e.sourceNodeId)), "edges point at the new nodes");
    const link = await withWorkspaceScope(report.workspaceId, (tx) => tx.noteLink.findFirstOrThrow({ where: { workspaceId: report.workspaceId } }));
    assert.equal(link.recordId, newProject.id, "a note's record link follows the re-keyed project");
    const runs = await withWorkspaceScope(report.workspaceId, (tx) => tx.agentRun.findMany({ where: { workspaceId: report.workspaceId } }));
    assert.ok(runs.some((r) => r.parentRunId && runs.some((p) => p.id === r.parentRunId)), "self-reference re-linked");
    assert.ok(runs.every((r) => r.status === "cancelled" || r.status === "succeeded" || r.status === "failed"), "in-flight runs cancelled");
    // Automations come back off.
    assert.equal(newWf.enabled, false);
    const sched = await withWorkspaceScope(report.workspaceId, (tx) => tx.scheduledSkill.findFirstOrThrow({ where: { workspaceId: report.workspaceId } }));
    assert.equal(sched.status, "paused");
    assert.ok(report.automationsPaused >= 2);
    // The file's bytes were copied to a new key and read back.
    assert.equal(report.files.copied, 1);
    const newFile = await prisma.workspaceFile.findFirstOrThrow({ where: { workspaceId: report.workspaceId } });
    const oldFile = await prisma.workspaceFile.findFirstOrThrow({ where: { id: fileId } });
    assert.notEqual(newFile.storageKey, oldFile.storageKey);
    const bytes = await readFile({ workspaceId: report.workspaceId, fileId: newFile.id });
    assert.equal(bytes?.bytes.toString(), `brief ${RUN}`);
    // The restorer owns the new workspace; old members are not copied.
    const members = await prisma.workspaceMember.findMany({ where: { workspaceId: report.workspaceId } });
    assert.deepEqual(members.map((m) => [m.userId, m.role]), [[ADM, "owner"]]);
    // Source untouched; both audit it; the snapshot remembers the restore.
    assert.equal(await prisma.project.count({ where: { workspaceId: WS } }), 1);
    assert.equal((await prisma.workflow.findFirstOrThrow({ where: { projectId } })).enabled, true);
    assert.ok(await prisma.fileChangeLog.findFirst({ where: { workspaceId: WS, action: "snapshot_restored" } }));
    assert.ok(await prisma.fileChangeLog.findFirst({ where: { workspaceId: report.workspaceId, action: "snapshot_restored" } }));
    assert.equal((await listSnapshots(WS)).find((x) => x.id === snapId)?.lastRestore?.workspaceId, report.workspaceId);
  });

  it("settings, retention and delete", async () => {
    const s = await tmSaveSettings(adm, { schedule: "weekly", retention: 2 });
    assert.deepEqual(s, { schedule: "weekly", retention: 2 });
    await assert.rejects(tmSaveSettings(adm, { schedule: "hourly" }), /off, daily or weekly/);
    await assert.rejects(tmSaveSettings(adm, { retention: 0 }), /Keep between/);
    await tmTakeSnapshot(adm);
    await tmTakeSnapshot(adm);
    assert.equal((await listSnapshots(WS)).filter((x) => x.status === "ready").length, 2, "retention 2 kept the newest two");
    await applyRetention(WS, 1);
    const left = await listSnapshots(WS);
    assert.equal(left.length, 1);
    await tmDeleteSnapshot(adm, left[0]!.id);
    assert.equal((await tmOverview(adm)).snapshots.length, 0);
  });
});
