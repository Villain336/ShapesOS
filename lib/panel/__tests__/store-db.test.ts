// Phase 19B (WS=panel) — persistence against real Postgres + pgvector, as the
// least-privilege app role:
//   - FORCE RLS on all seven panel tables: no GUC = zero rows, another
//     workspace = zero rows, a row for another workspace can't be written;
//     deleting the workspace cascades;
//   - PgMemoryStore keeps the MemoryStore contract the in-memory store has
//     (verbatim transcripts, relevance order by pgvector cosine, per-transcript
//     scope, per-persona scope, recency refresh).
// The embedder is the labelled FAKE lexicalTestEmbedder (384-d), so CI needs
// no model download; production embeds with MiniLM.
// Run: DATABASE_URL=<app role> npx tsx --test lib/panel/__tests__/store-db.test.ts

import "dotenv/config";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { lexicalTestEmbedder } from "../memory";
import { PgMemoryStore } from "../store.server";

const RUN = randomUUID().slice(0, 8);
const WS = `p19bst-${RUN}`;
const WS2 = `p19bst2-${RUN}`;
const TABLES = ["panel_transcripts", "panel_memory_nodes", "panel_personas", "panel_runs", "panel_steps", "panel_verdicts", "panel_calibrations"] as const;

async function seedEveryTable(ws: string): Promise<void> {
  await withWorkspaceScope(ws, async (tx) => {
    await tx.panelTranscript.create({ data: { id: `${ws}-t`, workspaceId: ws, title: "t", text: "x", createdBy: "u" } });
    await tx.panelMemoryNode.create({ data: { workspaceId: ws, kind: "interview", transcriptId: `${ws}-t`, nodeKey: `${ws}-t:chunk:0`, content: "x" } });
    await tx.panelPersona.create({ data: { workspaceId: ws, name: "P", spec: {}, createdBy: "u" } });
    const run = await tx.panelRun.create({ data: { id: `${ws}-r`, workspaceId: ws, target: {}, targetLabel: "x", personaSnapshot: [], stepCap: 2, model: "m", estimateCredits: 1, capCredits: 1, confirmedBy: "u" } });
    await tx.panelStep.create({ data: { workspaceId: ws, runId: run.id, personaKey: "p", personaName: "P", stepIndex: 0, observation: {}, signals: {}, startedAt: new Date(), endedAt: new Date() } });
    await tx.panelVerdict.create({ data: { workspaceId: ws, runId: run.id, personaKey: "p", personaName: "P", outcome: "bounced", timeline: {} } });
    await tx.panelCalibration.create({ data: { workspaceId: ws, runId: run.id, predictedRate: 0.5, predictedN: 2, actualConversions: 1, actualVisitors: 10, actualRate: 0.1, z: 1, pValue: 0.3, verdict: "within-noise", absError: 0.4, enteredBy: "u" } });
  });
}

async function count(table: string, ws: string | null): Promise<number> {
  const q = `SELECT count(*)::int AS n FROM "${table}"`;
  if (ws === null) return (await prisma.$queryRawUnsafe<Array<{ n: number }>>(q))[0]!.n;
  return withWorkspaceScope(ws, async (tx) => (await tx.$queryRawUnsafe<Array<{ n: number }>>(q))[0]!.n);
}

before(async () => {
  await prisma.workspace.deleteMany({ where: { id: { in: [WS, WS2] } } });
  await prisma.workspace.create({ data: { id: WS, name: `Panel ${RUN}`, ownerUserId: `u-${RUN}` } });
  await prisma.workspace.create({ data: { id: WS2, name: `Other ${RUN}`, ownerUserId: `u2-${RUN}` } });
});

after(async () => {
  await prisma.workspace.deleteMany({ where: { id: { in: [WS, WS2] } } });
  await prisma.$disconnect();
});

describe("FORCE RLS on every panel table", () => {
  it("own workspace sees its row; no GUC and another workspace see none", async () => {
    await seedEveryTable(WS);
    for (const t of TABLES) {
      assert.equal(await count(t, WS), 1, `${t} under its own workspace`);
      assert.equal(await count(t, WS2), 0, `${t} under another workspace`);
      assert.equal(await count(t, null), 0, `${t} with no workspace set`);
    }
  });

  it("a row for another workspace cannot be written under this workspace's scope", async () => {
    await assert.rejects(
      withWorkspaceScope(WS, (tx) => tx.panelPersona.create({ data: { workspaceId: WS2, name: "Smuggled", spec: {}, createdBy: "u" } })),
      /row-level security|violates/i,
    );
  });

  it("deleting the workspace cascades to every panel row", async () => {
    const tmp = `p19bst3-${RUN}`;
    await prisma.workspace.create({ data: { id: tmp, name: "tmp", ownerUserId: "u" } });
    await seedEveryTable(tmp);
    await prisma.workspace.delete({ where: { id: tmp } });
    for (const t of TABLES) assert.equal(await count(t, tmp), 0, t);
  });
});

describe("PgMemoryStore (pgvector)", () => {
  const store = new PgMemoryStore(WS, { embed: lexicalTestEmbedder, createdBy: "u" });

  it("stores a transcript verbatim and its chunks as interview nodes, in order", async () => {
    const text = "Interviewer: what stopped you? Priya: The pricing page confused me. It said $49 per month but annual billing was required. The cost felt too high. I worried about hidden fees.";
    const nodes = await store.addTranscript({ id: `tp-${RUN}`, text, title: "Pricing call", interviewee: "Priya", createdAt: Date.now() });
    assert.equal(nodes.length, 1);
    assert.equal((await store.getTranscript(`tp-${RUN}`))?.text, text);
    await store.addTranscript({ id: `to-${RUN}`, text: "The onboarding flow was smooth and the dashboard looked clean. I liked the colours.", createdAt: Date.now() });
    assert.deepEqual((await store.transcriptNodes(`to-${RUN}`)).map((n) => n.kind), ["interview"]);
  });

  it("retrieves by embedding similarity: the pricing interview first for a pricing query", async () => {
    const r = await store.retrieve("pricing cost per month annual billing", { k: 2, transcriptIds: [`tp-${RUN}`, `to-${RUN}`] });
    assert.equal(r[0]!.node.transcriptId, `tp-${RUN}`);
    assert.ok(r[0]!.relevance > r[1]!.relevance);
  });

  it("scopes walk nodes to their run and persona", async () => {
    const runId = `${WS}-r`;
    await store.addNode({ id: `${runId}:p1:0:thought`, kind: "thought", runId, personaKey: "p1", content: "pricing thought of p1", importance: 0.5, chunkIndex: 0 });
    await store.addNode({ id: `${runId}:p2:0:thought`, kind: "thought", runId, personaKey: "p2", content: "pricing thought of p2", importance: 0.5, chunkIndex: 0 });
    const ids = (await store.retrieve("pricing", { k: 10, transcriptIds: [`tp-${RUN}`], runId, personaKey: "p1" })).map((s) => s.node.id).sort();
    assert.deepEqual(ids, [`${runId}:p1:0:thought`, `tp-${RUN}:chunk:0`]);
  });

  it("refreshes last-retrieved on retrieval", async () => {
    const later = Date.now() + 100 * 3_600_000;
    const first = await store.retrieve("onboarding", { k: 1, transcriptIds: [`to-${RUN}`], now: later });
    assert.ok(first[0]!.recency < 0.4, "not retrieved for ~100 hours: 0.99^100 ≈ 0.366");
    const again = await store.retrieve("onboarding", { k: 1, transcriptIds: [`to-${RUN}`], now: later });
    assert.equal(again[0]!.recency, 1);
  });

  it("another workspace's store sees none of it", async () => {
    const other = new PgMemoryStore(WS2, { embed: lexicalTestEmbedder, createdBy: "u" });
    assert.equal(await other.getTranscript(`tp-${RUN}`), undefined);
    assert.deepEqual(await other.retrieve("pricing", { k: 10 }), []);
  });
});
