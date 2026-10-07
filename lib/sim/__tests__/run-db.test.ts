// Phase 19B (WS=engine) — a town rehearsal end to end against real Postgres,
// as the least-privilege app role, on the agent worker, with the labelled
// FAKE town model (no AI model is called, nothing is metered):
//   - the dress_rehearsal entitlement gate (below Pro → 403 + upgrade message);
//   - generate a town → estimate → confirm a cap → a `town_run` job → the
//     worker runs 3 days × 50 residents × A/B × 3 seeds → ranges, events,
//     hourly snapshots, residents, event hashes; spend ≤ the cap;
//   - interventions never write a real record: every workspace table outside
//     sim_* and agent_jobs is byte-identical before and after (snapshot diff);
//   - the cap stop: a tiny cap ends the run as an honest partial;
//   - replay from seed: the recorded decisions answer every point (0 model
//     calls) and the event logs hash the same — the determinism proof in the DB.
// Run: DATABASE_URL=<app role> PANEL_FAKE_MODEL=1 npx tsx --test lib/sim/__tests__/run-db.test.ts

import "dotenv/config";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { EntitlementError } from "@/lib/billing/entitlements";
import { AgentWorker } from "@/lib/agents/queue/worker";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { lexicalTestEmbedder } from "@/lib/panel/memory";
import { PgMemoryStore } from "@/lib/panel/store.server";
import { validSpec } from "../../panel/__tests__/fixtures";
import { testSimDeps } from "../deps.server";
import { createGeneratedWorld, estimateTown, getTownRun, listTownRuns, replayTownRun, startTownRun, type TownRunInput } from "../service.server";
import { proposeForReal } from "../real.server";
import { streamTownRun } from "../stream.server";
import type { PanelActor } from "@/lib/panel/service.server";

const RUN = randomUUID().slice(0, 8);
const WS = `p19btr-${RUN}`;
const WS_STARTER = `p19btrs-${RUN}`;
const ED = `p19btr-ed-${RUN}`;
const ed: PanelActor = { workspaceId: WS, userId: ED, role: "editor" };
const starter: PanelActor = { workspaceId: WS_STARTER, userId: ED, role: "editor" };
const deps = testSimDeps();
const silent = { info() {}, warn() {}, error() {} };

let personaId = "";
let worldId = "";
let newLotId = "";

function input(over: Partial<TownRunInput> = {}): TownRunInput {
  return {
    worldId,
    population: 50,
    segments: [
      { key: "maya", label: "Like Maya", share: 0.6, personaId },
      { key: "others", label: "Everyone else", share: 0.4 },
    ],
    days: 3,
    seeds: 3,
    baseSeed: 11,
    mode: "live",
    scenarioA: { label: "Launch at $40", product: { name: "Desk lamp", category: "home", priceCents: 4_000, description: "A warm desk lamp" }, storeHours: { openHour: 9, closeHour: 20 }, interventions: [{ kind: "ad_campaign", channel: "social", startDay: 0, endDay: 2, dailyBudgetCents: 1_200, creative: "A desk lamp for late nights" }] },
    scenarioB: { label: "Launch at $25", product: { name: "Desk lamp", category: "home", priceCents: 4_000, description: "A warm desk lamp" }, storeHours: { openHour: 9, closeHour: 20 }, interventions: [{ kind: "ad_campaign", channel: "social", startDay: 0, endDay: 2, dailyBudgetCents: 1_200, creative: "A desk lamp for late nights" }, { kind: "price_change", day: 0, priceCents: 2_500 }, { kind: "promotion", day: 1, endDay: 2, discountPct: 10, label: "Opening week", event: true }, { kind: "new_location", day: 1, lotId: newLotId }] },
    ...over,
  };
}

async function drainWorker(): Promise<void> {
  const w = new AgentWorker({ kinds: ["town_run"], concurrency: 1, log: silent });
  for (let i = 0; i < 5; i++) {
    const n = await w.tick();
    await w.drain();
    if (n === 0) break;
  }
}

/** Every table with a workspace_id column except the town's own and the job queue: a content hash per table. */
async function realRecordSnapshot(): Promise<Record<string, string>> {
  const tables = await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
    `SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema
      WHERE c.table_schema = 'public' AND c.column_name = 'workspace_id' AND t.table_type = 'BASE TABLE'
        AND c.table_name NOT LIKE 'sim\\_%' AND c.table_name <> 'agent_jobs' ORDER BY 1`,
  );
  const out: Record<string, string> = {};
  for (const { table_name } of tables) {
    const [row] = await withWorkspaceScope(WS, (tx) =>
      tx.$queryRawUnsafe<Array<{ n: number; h: string | null }>>(`SELECT count(*)::int AS n, md5(string_agg(x::text, '|' ORDER BY x::text)) AS h FROM "${table_name}" x WHERE workspace_id = $1`, WS),
    );
    out[table_name] = `${row!.n}:${row!.h ?? "-"}`;
  }
  return out;
}

before(async () => {
  await prisma.workspace.deleteMany({ where: { id: { in: [WS, WS_STARTER] } } });
  await prisma.workspace.create({ data: { id: WS, name: `Town ${RUN}`, ownerUserId: ED, plan: "pro" } });
  await prisma.workspace.create({ data: { id: WS_STARTER, name: `Starter ${RUN}`, ownerUserId: ED, plan: "starter" } });
  await prisma.workspaceMember.createMany({ data: [{ workspaceId: WS, userId: ED, role: "editor", email: `ed-${RUN}@example.test` }, { workspaceId: WS_STARTER, userId: ED, role: "editor", email: `ed-${RUN}@example.test` }] });
  // A calibrated persona: its interview is in the memory stream (FAKE 384-d embedder).
  const store = new PgMemoryStore(WS, { embed: lexicalTestEmbedder, createdBy: ED });
  const tid = `t-${RUN}`;
  await store.addTranscript({ id: tid, title: "Maya interview", text: "Maya: I work late most nights. Honestly a lamp over $30 is too expensive for a student budget like mine. I buy things my friends recommend.", createdAt: Date.now() });
  const persona = await withWorkspaceScope(WS, (tx) =>
    tx.panelPersona.create({ data: { workspaceId: WS, name: "Maya", spec: validSpec({ identity: { name: "Maya", role: "Student" }, knownObjections: [{ text: "A lamp over $30 is too expensive for a student budget", severity: "medium", sourceTranscriptId: tid }], sourceTranscriptIds: [tid], budget: { currency: "USD", monthlyMax: 45, hardCap: true } }), sourceTranscriptIds: [tid], calibrated: true, createdBy: ED } }),
  );
  personaId = persona.id;
});

after(async () => {
  await prisma.workspace.deleteMany({ where: { id: { in: [WS, WS_STARTER] } } });
  await prisma.$disconnect();
});

describe("entitlement gate", () => {
  it("below Pro, town calls are a 403 with the upgrade message", async () => {
    for (const call of [() => listTownRuns(starter), () => createGeneratedWorld(starter, { size: "small", seed: 1 })]) {
      await assert.rejects(call(), (e: unknown) => e instanceof EntitlementError && e.status === 403 && /Upgrade to Pro/.test(e.message));
    }
  });
});

describe("a town rehearsal on the worker (FAKE model)", () => {
  it("generate → estimate → confirm → town_run job → ranges, events, snapshots; no real record written", async () => {
    const world = await createGeneratedWorld(ed, { size: "small", seed: 4, name: "Rehearsal town" });
    worldId = world.id;
    newLotId = world.layout.lots.find((l) => l.kind === "cafe")!.id;
    const inp = input();
    const est = await estimateTown(ed, inp, deps);
    assert.equal(est.modelKind, "fake");
    assert.ok(est.estimate.capCredits >= est.estimate.expectedCredits);
    await assert.rejects(startTownRun(ed, { ...inp, capCredits: est.estimate.capCredits, confirmed: false }, deps), /confirm/i);

    const before = await realRecordSnapshot();
    const run = await startTownRun(ed, { ...inp, capCredits: est.estimate.capCredits, confirmed: true }, deps);
    assert.equal(run.status, "queued");
    await drainWorker();
    const done = await getTownRun(ed, run.id);
    assert.equal(done.status, "completed", done.stopReason ?? "");
    assert.equal(done.modelKind, "fake");
    assert.ok(done.spentCredits > 0 && done.spentCredits <= done.capCredits);
    const report = done.report!;
    assert.equal(report.synthetic, true);
    assert.match(report.banner, /Not representative/);
    assert.equal(report.variants.A.adoption.length, 3);
    assert.ok(report.variants.B!.adoption.every((r) => r.n === 3), "every day is a range over 3 seeds");
    assert.equal(report.comparison!.withheld, "no_calibration", "no launch entered yet → no verdict");
    assert.equal(Object.keys(done.eventHashes ?? {}).length, 6);
    const counts = await withWorkspaceScope(WS, async (tx) => ({
      residents: await tx.simResident.count({ where: { runId: run.id } }),
      snapsA: await tx.simSnapshot.count({ where: { runId: run.id, variant: "A", seedIndex: 0 } }),
      trips: await tx.simEvent.count({ where: { runId: run.id, variant: "A", seedIndex: 0, type: "trip" } }),
    }));
    assert.deepEqual([counts.residents, counts.snapsA], [50, 72]);
    assert.ok(counts.trips > 100);
    // Interventions are simulated objects only.
    assert.deepEqual(await realRecordSnapshot(), before);
  });

  it("a tiny cap stops the run cleanly: partial, where it stopped, spend within the cap", async () => {
    const run = await startTownRun(ed, { ...input(), capCredits: 6, confirmed: true }, deps);
    await drainWorker();
    const done = await getTownRun(ed, run.id);
    assert.equal(done.status, "partial");
    assert.equal(done.stopReason, "cap");
    assert.match(String((done.stoppedAt as { detail?: string } | null)?.detail), /Stopped at \w+ \(day 1\)/);
    assert.ok(done.spentCredits <= 6);
    assert.ok(done.report!.stopped, "the report says it stopped");
  });

  it("replay from seed: recorded decisions answer every point — 0 model calls — and the event logs hash the same", async () => {
    const original = (await listTownRuns(ed)).find((r) => r.status === "completed")!;
    const replay = await replayTownRun(ed, original.id, { capCredits: 10, confirmed: true }, deps);
    await drainWorker();
    const done = await getTownRun(ed, replay.id);
    assert.equal(done.status, "completed");
    assert.equal(done.callCount, 0, "no model call on a replay");
    const orig = await getTownRun(ed, original.id);
    assert.deepEqual(done.eventHashes, orig.eventHashes);
  });

  it('"do this for real": a normal proposal through executeTool — the ad campaign is Tier 3 and asks even with an auto-approve rule; a non-money change can run on a rule', async () => {
    const run = (await listTownRuns(ed)).find((r) => r.status === "completed" && r.scenarioB)!;
    await withWorkspaceScope(WS, (tx) =>
      tx.automationSetting.createMany({
        data: [
          { workspaceId: WS, agentKey: "*", action: "spend_launch_ad_budget", behavior: "auto", updatedBy: ED },
          { workspaceId: WS, agentKey: "*", action: "apply_launch_change", behavior: "auto", updatedBy: ED },
        ],
      }),
    );
    const notes = () => withWorkspaceScope(WS, (tx) => tx.univerDoc.count({ where: { workspaceId: WS, kind: "note" } }));
    const before = await notes();
    const ad = await proposeForReal(ed, run.id, { variant: "A", index: 0 });
    assert.equal(ad.tool, "fund_launch_ad_campaign");
    assert.equal(ad.status, "pending_confirmation", "Tier 3 always asks a person");
    assert.equal(await notes(), before, "a proposal writes nothing");
    const price = await proposeForReal(ed, run.id, { variant: "B", index: 1 });
    assert.equal(price.tool, "apply_launch_change");
    assert.equal(price.status, "executed", "Tier 2 can run on the workspace's auto-approve rule");
    const okd = await proposeForReal(ed, run.id, { variant: "A", index: 0, confirmed: true });
    assert.equal(okd.status, "executed", "the person's explicit OK runs it");
    assert.equal(await notes(), before + 2);
  });

  it("streams a run over SSE: meta, pages of events with a Last-Event-ID cursor, a seek via the hourly snapshot, resume after an id, end", async () => {
    const run = (await listTownRuns(ed)).find((r) => r.status === "completed" && r.scenarioB)!;
    const collect = async (opts: Parameters<typeof streamTownRun>[2]) => {
      const sent: Array<{ event: string | null; data: unknown; id?: string | null }> = [];
      const ac = new AbortController();
      await streamTownRun(ed, run.id, opts, { send: (event, data, o) => (sent.push({ event, data, id: o?.id }), true), closed: false, signal: ac.signal });
      return sent;
    };
    const all = await collect({ variant: "A" });
    assert.equal(all[0]!.event, "meta");
    assert.equal(all.at(-1)!.event, "end");
    const events = all.filter((m) => m.event === "events").flatMap((m) => m.data as Array<{ seq: number; t: number; type: string }>);
    const stored = await withWorkspaceScope(WS, (tx) => tx.simEvent.count({ where: { runId: run.id, variant: "A", seedIndex: 0 } }));
    assert.equal(events.length, stored, "every event of the played seed, once");
    assert.ok(events.some((e) => e.type === "trip" && Array.isArray((e as { d?: { path?: unknown } }).d?.path)), "trips carry timestamped paths");
    const pages = all.filter((m) => m.event === "events");
    assert.equal(pages.at(-1)!.id, `A:${events.at(-1)!.seq}`);

    const seekAt = 1 * 1440 + 8 * 60 + 30; // Tuesday 08:30
    const seek = await collect({ variant: "A", fromMinute: seekAt });
    assert.equal(seek[1]!.event, "snapshot");
    const snapT = (seek[1]!.data as { t: number }).t;
    assert.equal(snapT, 1 * 1440 + 8 * 60, "the hourly snapshot at or before the seek");
    const firstAfterSeek = (seek.find((m) => m.event === "events")!.data as Array<{ t: number }>)[0]!;
    assert.ok(firstAfterSeek.t >= snapT);

    const resume = await collect({ variant: "A", lastEventId: "A:100" });
    assert.equal((resume.find((m) => m.event === "events")!.data as Array<{ seq: number }>)[0]!.seq, 101);
  });
});
