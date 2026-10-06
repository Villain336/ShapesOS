// ShapesOS — Phase 18.3 (WS=trust) DB test: one audit timeline.
//   - rows from several trails (workspace log, agent run steps, ops, the
//     command bar, a hash-chained mission trail) in ONE newest-first list;
//   - only THIS workspace (another workspace's rows never appear, even in
//     FORCE-RLS tables), agent run steps as summaries only;
//   - filters (agents vs people, source) and cursor paging;
//   - the route is admin+ (a viewer gets 403), CSV export is audited;
//   - the mission chain verifies with the writer's own hash functions, and a
//     tampered row is reported as broken.
// Real Postgres as the least-privilege app role; the session is a node:test
// module MOCK of lib/session (labelled).
// Run: DATABASE_URL=<app role> npx tsx --test --experimental-test-module-mocks lib/audit-timeline/__tests__/timeline-db.test.ts
// Listed in scripts/test/db-tests.txt.

import "dotenv/config";
import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const RUN = randomUUID().slice(0, 8);
const WS = `tl-ws-${RUN}`;
const WS_B = `tl-wsb-${RUN}`;
const ADMIN = `tl-admin-${RUN}`;
const VIEWER = `tl-viewer-${RUN}`;
let actor = { id: ADMIN, email: "admin@tl.test" };

// MOCK: the signed-in session (no Auth.js cookie in a unit runner).
mock.module("@/lib/session", {
  namedExports: {
    requireUser: async () => actor,
    getOrCreateWorkspace: async () => ({ id: WS, name: WS }),
  },
});

let prisma: typeof import("@/lib/prisma").prisma;
let scope: typeof import("@/lib/substrate/memory/rls").withWorkspaceScope;
let tl: typeof import("../timeline.server");
let chains: typeof import("../chains.server");
let route: typeof import("@/app/api/trust/timeline/route");
let missionId = "";

const get = (q = "") => route.GET(Object.assign(new Request(`http://x/api/trust/timeline${q}`), { nextUrl: new URL(`http://x/api/trust/timeline${q}`) }) as never);

before(async () => {
  ({ prisma } = await import("@/lib/prisma"));
  ({ withWorkspaceScope: scope } = await import("@/lib/substrate/memory/rls"));
  tl = await import("../timeline.server");
  chains = await import("../chains.server");
  route = await import("@/app/api/trust/timeline/route");
  for (const id of [WS, WS_B]) await prisma.workspace.create({ data: { id, name: id, ownerUserId: ADMIN } });
  await prisma.workspaceMember.createMany({
    data: [
      { workspaceId: WS, userId: ADMIN, role: "admin", name: "Ada Admin" },
      { workspaceId: WS, userId: VIEWER, role: "viewer" },
      { workspaceId: WS_B, userId: ADMIN, role: "owner" },
    ],
  });
  const t0 = Date.now() - 60_000;
  for (const [ws, tag] of [[WS, "A"], [WS_B, "B"]] as const) {
    await prisma.fileChangeLog.create({ data: { workspaceId: ws, filePath: "(workspace)", actor: "user", action: "member_added", summary: `member added ${tag}`, approvedBy: ADMIN, createdAt: new Date(t0 + 1000) } });
    await scope(ws, async (tx) => {
      const run = await tx.agentRun.create({ data: { workspaceId: ws, kind: "chat", status: "succeeded", startedBy: ADMIN, agentKey: "researcher" } });
      await tx.agentRunEvent.create({ data: { workspaceId: ws, runId: run.id, seq: 0, type: "agui", summary: `web_search: found 3 ${tag}`, payload: { kind: "tool_result", tool: "web_search", status: "executed", secret: "PAYLOAD-NEVER-SHOWN" }, createdAt: new Date(t0 + 2000) } });
      await tx.agentRunEvent.create({ data: { workspaceId: ws, runId: run.id, seq: 1, type: "text", summary: "streamed text", createdAt: new Date(t0 + 2500) } });
      await tx.opsAuditEvent.create({ data: { workspaceId: ws, entity: "invoices", entityId: "inv1", action: "list", actor: "agent:actor", summary: `listed ${tag}`, createdAt: new Date(t0 + 3000) } });
      await tx.commandAudit.create({ data: { workspaceId: ws, userId: ADMIN, kind: "ask", resultSummary: `asked ${tag}`, createdAt: new Date(t0 + 4000) } });
    });
  }
  const { appendMissionEvent } = await import("@/lib/orchestrator/audit");
  const m = await scope(WS, (tx) => tx.mission.create({ data: { workspaceId: WS, template: "outreach_sprint", goal: { text: "g" }, planSnapshot: {}, checkpoints: [], budgetCaps: {}, termination: {}, createdBy: ADMIN }, select: { id: true } }));
  missionId = m.id;
  await appendMissionEvent({ missionId, workspaceId: WS, actor: "lead", step: "plan", tool: "web.search", args: { q: "x" } });
  await appendMissionEvent({ missionId, workspaceId: WS, actor: "lead", step: "draft", observation: { ok: true } });
});

after(async () => {
  await prisma.fileChangeLog.deleteMany({ where: { workspaceId: { in: [WS, WS_B] } } });
  await prisma.workspace.deleteMany({ where: { id: { in: [WS, WS_B] } } });
  await prisma.$disconnect();
});

describe("audit timeline (DB)", () => {
  it("one newest-first list across the trails, this workspace only, summaries only", async () => {
    const page = await tl.loadTimeline(WS);
    const sources = new Set(page.entries.map((e) => e.source));
    for (const s of ["file_change_log", "agent_run_event", "ops_audit_event", "command_audit", "mission_event"]) assert.ok(sources.has(s as never), `has ${s}`);
    const text = JSON.stringify(page.entries);
    assert.ok(!/ B"|added B|found 3 B|listed B|asked B/.test(text), "nothing from the other workspace");
    assert.ok(!text.includes("PAYLOAD-NEVER-SHOWN"), "agent steps are summaries only");
    assert.ok(!text.includes("streamed text"), "streamed text is not a step");
    for (let i = 1; i < page.entries.length; i++) assert.ok(page.entries[i - 1]!.at >= page.entries[i]!.at, "newest first");
    const member = page.entries.find((e) => e.source === "file_change_log")!;
    assert.equal(member.actor.label, "Ada Admin", "people show by their member name");
    assert.equal(page.errors.length, 0, JSON.stringify(page.errors));
  });

  it("filters agents vs people and by source; pages with a cursor", async () => {
    const agents = await tl.loadTimeline(WS, { actorKind: "agent" });
    assert.ok(agents.entries.length >= 3);
    assert.ok(agents.entries.every((e) => e.actor.kind === "agent"));
    const people = await tl.loadTimeline(WS, { actorKind: "person" });
    assert.ok(people.entries.every((e) => e.actor.kind === "person"));
    const ops = await tl.loadTimeline(WS, { sources: ["ops_audit_event"] });
    assert.deepEqual([...new Set(ops.entries.map((e) => e.source))], ["ops_audit_event"]);
    const all = await tl.loadTimeline(WS, {}, null, 200);
    const p1 = await tl.loadTimeline(WS, {}, null, 2);
    assert.ok(p1.next);
    const p2 = await tl.loadTimeline(WS, {}, p1.next, 2);
    assert.deepEqual([...p1.entries, ...p2.entries].map((e) => e.key), all.entries.slice(0, 4).map((e) => e.key), "pages join without gaps or repeats");
  });

  it("the route is admin+: a viewer gets 403; CSV export is audited", async () => {
    actor = { id: VIEWER, email: "v@tl.test" };
    assert.equal((await get()).status, 403);
    actor = { id: ADMIN, email: "admin@tl.test" };
    const ok = await get("?actor=agent");
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as { entries: Array<{ actor: { kind: string } }> };
    assert.ok(body.entries.length > 0 && body.entries.every((e) => e.actor.kind === "agent"));
    const csv = await get("?format=csv");
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get("content-type") ?? "", /text\/csv/);
    const text = await csv.text();
    assert.match(text.split("\n")[0]!, /^at,actor_kind,actor,action,target,source,summary,link$/);
    assert.ok(text.split("\n").length > 3);
    assert.ok(await prisma.fileChangeLog.findFirst({ where: { workspaceId: WS, action: "audit_timeline_exported" } }), "the export is audited");
  });

  it("the mission chain verifies; a tampered entry is reported", async () => {
    const before = await chains.verifyChains(WS);
    const mission = before.find((c) => c.source === "mission_event")!;
    assert.equal(mission.ok, true);
    assert.equal(mission.checked, 2);
    assert.equal(before.find((c) => c.source === "flywheel_audit_event")!.ok, null, "not verified here — said so, never guessed");
    // Tamper with the first event's arguments (as the migrator would have to).
    const first = await scope(WS, (tx) => tx.missionEvent.findFirst({ where: { missionId }, orderBy: { ts: "asc" } }));
    await scope(WS, (tx) => tx.missionEvent.update({ where: { id: first!.id }, data: { args: { q: "changed" } } }));
    const after = (await chains.verifyChains(WS)).find((c) => c.source === "mission_event")!;
    assert.equal(after.ok, false);
    assert.equal(after.brokenAt, first!.id);
  });
});
