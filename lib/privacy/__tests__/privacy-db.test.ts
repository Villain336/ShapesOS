// ShapesOS — Phase 18.3 (WS=trust) DB test: the data access log and memory controls.
//   Data access log — a seeded run's tool steps become rows (reads only: an
//     executed safe tool and a connector "list" call; a write, a denied call
//     and a pending one never do), mapped to their app; ops reads by an agent
//     too; "what agents read for you" is only runs you started; another
//     workspace never shows.
//   Memory controls — a person sees memories from their own work, an admin
//     the workspace's; "forget" deletes the row (its embedding lives in the
//     row) under RLS, recall can no longer return it, a person can't forget
//     someone else's memory, and every forget is audited without the text.
// Real Postgres as the least-privilege app role.
// Run: DATABASE_URL=<app role> npx tsx --test lib/privacy/__tests__/privacy-db.test.ts
// Listed in scripts/test/db-tests.txt.

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const RUN = randomUUID().slice(0, 8);
const WS = `pv-ws-${RUN}`;
const WS_B = `pv-wsb-${RUN}`;
const ANA = `pv-ana-${RUN}`;
const BEN = `pv-ben-${RUN}`;
const PHRASE = `zebra-${RUN}-fact`;

let prisma: typeof import("@/lib/prisma").prisma;
let scope: typeof import("@/lib/substrate/memory/rls").withWorkspaceScope;
let access: typeof import("../data-access");
let memory: typeof import("../memory");
let anaRun = "";
let anaEpisode = "";
let benEpisode = "";
let fact = "";

const lookup = (name: string) =>
  name === "web_search"
    ? { kind: "safe", group: "web" as const }
    : name === "mail_send"
      ? { kind: "write", group: "email" as const }
      : name === "mail_list_threads"
        ? { kind: "safe", group: "email" as const }
        : null;

before(async () => {
  ({ prisma } = await import("@/lib/prisma"));
  ({ withWorkspaceScope: scope } = await import("@/lib/substrate/memory/rls"));
  access = await import("../data-access");
  memory = await import("../memory");
  for (const id of [WS, WS_B]) await prisma.workspace.create({ data: { id, name: id, ownerUserId: ANA } });
  await prisma.workspaceMember.createMany({ data: [{ workspaceId: WS, userId: ANA, role: "owner" }, { workspaceId: WS, userId: BEN, role: "editor" }] });
  for (const ws of [WS, WS_B]) {
    await scope(ws, async (tx) => {
      const run = await tx.agentRun.create({ data: { workspaceId: ws, kind: "chat", status: "succeeded", startedBy: ANA, agentKey: "researcher" } });
      if (ws === WS) anaRun = run.id;
      const steps: Array<[string, Record<string, unknown>]> = [
        ["web_search: 3 results", { kind: "tool_result", tool: "web_search", status: "executed" }],
        ["connector.gmail.list_messages: 5", { kind: "tool_result", tool: "connector.gmail.list_messages", status: "executed" }],
        ["mail_send", { kind: "tool_result", tool: "mail_send", status: "executed" }],
        ["denied", { kind: "tool_result", tool: "mail_list_threads", status: "denied" }],
        ["waiting", { kind: "tool_result", tool: "connector.gmail.send_email", status: "pending_confirmation" }],
      ];
      for (const [i, [summary, payload]] of steps.entries()) {
        await tx.agentRunEvent.create({ data: { workspaceId: ws, runId: run.id, seq: i, type: "agui", summary, payload: payload as object } });
      }
      const benRun = await tx.agentRun.create({ data: { workspaceId: ws, kind: "chat", status: "succeeded", startedBy: BEN, agentKey: "lead" } });
      await tx.agentRunEvent.create({ data: { workspaceId: ws, runId: benRun.id, seq: 0, type: "agui", summary: "ben's read", payload: { kind: "tool_result", tool: "web_search", status: "executed" } } });
      await tx.opsAuditEvent.create({ data: { workspaceId: ws, entity: "invoices", entityId: null, action: "list", actor: "agent:actor", summary: "listed invoices" } });
      await tx.opsAuditEvent.create({ data: { workspaceId: ws, entity: "invoices", entityId: "i1", action: "get", actor: ANA, summary: "a person read" } });
    });
  }
  await scope(WS, async (tx) => {
    const e1 = await tx.memoryEpisode.create({ data: { workspaceId: WS, episodeType: "agent_call", actor: "content-brief", summary: `agent_call:content-brief — Ana's draft ${RUN}`, refs: { userId: ANA }, startedAt: new Date() } });
    const e2 = await tx.memoryEpisode.create({ data: { workspaceId: WS, episodeType: "agent_call", actor: "content-brief", summary: `agent_call:content-brief — Ben's draft ${RUN}`, refs: { userId: BEN }, startedAt: new Date() } });
    anaEpisode = e1.id;
    benEpisode = e2.id;
    const f = await tx.memoryFact.create({ data: { workspaceId: WS, predicate: PHRASE, object: { v: "Ana prefers short emails" }, validAt: new Date(Date.now() - 60_000), sourceEpisodeId: e1.id } });
    fact = f.id;
    // A real (synthetic) embedding in the row: forgetting must take it too.
    const vec = `[${Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0)).join(",")}]`;
    await tx.$executeRawUnsafe(`UPDATE "memory_facts" SET "embedding" = $1::vector WHERE "id" = $2`, vec, fact);
  });
});

after(async () => {
  await prisma.fileChangeLog.deleteMany({ where: { workspaceId: { in: [WS, WS_B] } } });
  await prisma.workspace.deleteMany({ where: { id: { in: [WS, WS_B] } } });
  await prisma.$disconnect();
});

describe("data access log (DB)", () => {
  it("rows for a seeded run: reads only, mapped to their app; this workspace only", async () => {
    const rows = await access.loadDataAccess({ workspaceId: WS }, { lookup });
    const runRows = rows.filter((r) => r.runId === anaRun);
    assert.deepEqual(runRows.map((r) => [r.what, r.group]).sort(), [["connector.gmail.list_messages", "email"], ["web_search", "web"]]);
    assert.ok(runRows.every((r) => r.agent === "researcher" && r.forUserId === ANA));
    assert.ok(rows.some((r) => r.source === "ops_read" && r.group === "ops" && r.agent === "actor"), "an agent's ops read");
    assert.ok(!rows.some((r) => r.source === "ops_read" && r.what === "invoices i1"), "a person's read isn't an agent read");
    const other = await access.loadDataAccess({ workspaceId: WS_B }, { lookup });
    assert.ok(!other.some((r) => r.runId === anaRun), "another workspace never shows");
  });

  it("what agents read for you: only runs you started", async () => {
    const mine = await access.loadDataAccess({ workspaceId: WS, forUserId: BEN }, { lookup });
    assert.equal(mine.length, 1);
    assert.equal(mine[0]!.forUserId, BEN);
    const filtered = await access.loadDataAccess({ workspaceId: WS, group: "email" }, { lookup });
    assert.ok(filtered.length >= 1 && filtered.every((r) => r.group === "email"));
  });
});

describe("memory controls (DB)", () => {
  it("a person sees memories from their own work; an admin sees the workspace's", async () => {
    const anas = await memory.listMemory({ workspaceId: WS, store: "episode", forUserId: ANA });
    assert.deepEqual(anas.map((m) => m.id), [anaEpisode]);
    const anaFacts = await memory.listMemory({ workspaceId: WS, store: "fact", forUserId: ANA });
    assert.deepEqual(anaFacts.map((m) => m.id), [fact]);
    assert.equal((await memory.listMemory({ workspaceId: WS, store: "fact", forUserId: BEN })).length, 0);
    const all = await memory.listMemory({ workspaceId: WS, store: "episode" });
    assert.ok(all.some((m) => m.id === benEpisode) && all.some((m) => m.id === anaEpisode));
    assert.equal((await memory.listMemory({ workspaceId: WS_B, store: "episode" })).length, 0, "another workspace sees none");
  });

  it("forget removes the item and its recall hits (and its embedding)", async () => {
    const { memoryRecall } = await import("@/lib/substrate/memory/recall");
    const before = await memoryRecall(WS, { query: `"${PHRASE}"`, topK: 5 });
    assert.ok(before.some((h) => h.refId === fact), "recall finds it before");
    const byId = await memoryRecall(WS, { query: fact, topK: 5 });
    assert.ok(byId.some((h) => h.refId === fact));
    // Ben can't forget Ana's memory from "his own" view.
    await assert.rejects(memory.forgetMemory({ workspaceId: WS, store: "fact", id: fact, actorUserId: BEN, forUserId: BEN }), /isn't there/);
    await memory.forgetMemory({ workspaceId: WS, store: "fact", id: fact, actorUserId: ANA, forUserId: ANA });
    const after = await memoryRecall(WS, { query: `"${PHRASE}"`, topK: 5 });
    assert.ok(!after.some((h) => h.refId === fact), "recall can't return it");
    assert.ok(!(await memoryRecall(WS, { query: fact, topK: 5 })).some((h) => h.refId === fact));
    const left = await scope(WS, (tx) =>
      tx.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM "memory_facts" WHERE "workspace_id" = $1 AND ("id" = $2 OR "embedding" IS NOT NULL)`, WS, fact),
    );
    assert.equal(left[0]!.n, 0, "the row and its embedding are gone");
    const audit = await prisma.fileChangeLog.findFirst({ where: { workspaceId: WS, action: "memory_forgotten" } });
    assert.ok(audit);
    assert.ok(!audit!.summary.includes("short emails"), "the audit never repeats the forgotten text");
  });

  it("an admin forgets a workspace memory; citing rows keep existing without it", async () => {
    await scope(WS, (tx) => tx.memoryLearning.create({ data: { workspaceId: WS, hypothesis: "short subject lines win", action: "test it", result: "worked", observedAt: new Date(), source: "consolidation", sourceEpisodeId: benEpisode } }));
    await memory.forgetMemory({ workspaceId: WS, store: "episode", id: benEpisode, actorUserId: ANA });
    const rows = await scope(WS, (tx) => tx.memoryLearning.findMany({ where: { workspaceId: WS, hypothesis: "short subject lines win" }, select: { sourceEpisodeId: true } }));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.sourceEpisodeId, null);
    // Fail closed without the tenant GUC: no memory row is visible at all.
    assert.equal(await prisma.memoryEpisode.count({ where: { workspaceId: WS } }), 0);
  });
});
