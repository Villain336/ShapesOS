// ShapesOS — Phase 19B (WS=engine): the `town_run` job on the agent worker.
// Commercial layer (entitlement dress_rehearsal). Architecture: lib/sim/engine.ts.
//
// Runs scenario A (and B) × N seeds under ONE PanelLedger — the hard cap the
// person confirmed — and persists as it goes:
//   * seed 0 of each scenario (the one the map plays): every event, flushed
//     at the end of each sim-day so the Town tab can stream it while the run
//     is still going, plus one snapshot per sim-hour (seeking);
//   * other seeds: decisions, visits, adoptions, interventions and a cap stop
//     only (the replay cache and the report's inputs) — not every footstep;
//   * every sub-run's event log is fingerprinted (sha256, lib/sim/hash.ts)
//     as it streams: run.eventHashes, the determinism proof.
// A second claim of a run that was already running (the worker died) marks
// it an honest partial ("interrupted") instead of spending again. A cancel
// (status → cancelled) is seen at the next sim-day and stops the run.
// The decider: rules / the labelled fake (never in production) / the
// router model behind the decision cache (seeded from the original run's
// recorded decisions on a replay) / Message Batches for "deep" runs.

import type { Prisma } from "@prisma/client";
import { PanelLedger } from "@/lib/panel/budget";
import { calibrationScore } from "@/lib/panel/validator";
import { PgMemoryStore } from "@/lib/panel/store.server";
import { lexicalTestEmbedder } from "@/lib/panel/memory";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { BatchTownDecider } from "./batch";
import { DecisionCache, ModelDecider, RulesDecider, type AnyDecisionValue, type TownDecider } from "./decisions";
import { defaultSimDeps, type SimDeps } from "./deps.server";
import type { TownEvent } from "./engine";
import { fakeTownModel } from "./fake-model";
import { EventHasher } from "./hash";
import type { TownLayout } from "./layout";
import type { PersonaSeed, Resident } from "./residents";
import { buildTownReport, type CalibrationState } from "./results";
import { runScenarios, type Variant } from "./runner";
import type { Scenario } from "./scenario";
import { appendEvents, insertSnapshots, recordedDecisions } from "./store.server";

/** What other seeds keep in sim_events (seed 0 keeps everything). */
const KEEP_FOR_OTHER_SEEDS = new Set(["decision", "visit", "adopt", "intervention", "cap_stop", "end"]);
const TERMINAL = new Set(["completed", "partial", "failed", "cancelled"]);

export interface TownRunJobPayload {
  workspaceId: string;
  simRunId: string;
}

/** The workspace's calibration track record (the panel's panel_calibrations). */
export async function workspaceCalibration(workspaceId: string): Promise<CalibrationState> {
  const rows = await withWorkspaceScope(workspaceId, (tx) => tx.panelCalibration.findMany({ where: { workspaceId }, select: { predictedRate: true, actualRate: true } }));
  return { launches: rows.length, score: rows.length ? calibrationScore(rows) : null };
}

export async function runTownJob(payload: TownRunJobPayload, ctx: { signal?: AbortSignal } = {}, deps: SimDeps = defaultSimDeps): Promise<{ status: string }> {
  const ws = payload.workspaceId;
  const scoped = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) => withWorkspaceScope(ws, fn);
  const run = await scoped((tx) => tx.simRun.findFirst({ where: { id: payload.simRunId, workspaceId: ws } }));
  if (!run || TERMINAL.has(run.status)) return { status: run?.status ?? "missing" };
  if (run.status === "running") {
    await scoped((tx) => tx.simRun.update({ where: { id: run.id }, data: { status: "partial", stopReason: "interrupted", stoppedAt: { detail: "The worker running this rehearsal stopped before it finished; it was not restarted so nothing is spent twice." }, finishedAt: new Date() } }));
    return { status: "partial" };
  }
  await scoped((tx) => tx.simRun.update({ where: { id: run.id }, data: { status: "running", startedAt: new Date() } }));

  const fail = async (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    await scoped((tx) => tx.simRun.update({ where: { id: run.id }, data: { status: "failed", stopReason: "error", progress: { error: message.slice(0, 500) }, finishedAt: new Date() } }));
    return { status: "failed" };
  };

  try {
    const world = await scoped((tx) => tx.simWorld.findFirst({ where: { id: run.worldId, workspaceId: ws } }));
    if (!world) return await fail(new Error("The town of this run no longer exists."));
    const layout = world.layout as unknown as TownLayout;
    const rows = await scoped((tx) => tx.simResident.findMany({ where: { runId: run.id, workspaceId: ws }, orderBy: { residentKey: "asc" } }));
    const residents: Resident[] = rows.map((r) => ({ ...(r.data as object), id: r.residentKey, name: r.name, segment: r.segment, personaId: r.personaId, calibrated: r.calibrated, homeLotId: r.homeLotId, workLotId: r.workLotId, routine: r.routine }) as Resident);
    const personas = (run.personaSnapshot as unknown as PersonaSeed[]) ?? [];
    const scenarios = { A: run.scenarioA as unknown as Scenario, B: (run.scenarioB as unknown as Scenario | null) ?? null };

    // ── the decider ──────────────────────────────────────────────────────
    const ledger = new PanelLedger();
    ledger.beginRun(run.id, run.capCredits);
    const cache = new DecisionCache(run.replayOf ? ((await recordedDecisions(ws, run.replayOf)) as Array<[string, AnyDecisionValue]>) : []);
    let decider: TownDecider;
    if (run.mode === "rules" || run.modelKind === "rules") {
      decider = new RulesDecider();
    } else {
      let model;
      if (run.modelKind === "fake") {
        if (process.env.NODE_ENV === "production") return await fail(new Error("The fake model is never used in production."));
        model = fakeTownModel(ledger);
      } else {
        model = await deps.modelFor(ws, ledger, run.confirmedBy);
      }
      const direct = new ModelDecider(model, cache);
      const batcher = run.mode === "deep" && run.modelKind === "live" ? await deps.batchProviderFor(ws) : null;
      decider = batcher ? new BatchTownDecider({ provider: batcher, ledger, cache, direct, usage: { workspaceId: ws, actorId: run.confirmedBy, billing: "tokens" }, signal: ctx.signal }) : direct;
    }

    // ── run + persist as it goes ─────────────────────────────────────────
    const abort = new AbortController();
    ctx.signal?.addEventListener("abort", () => abort.abort(ctx.signal!.reason), { once: true });
    const key = (v: Variant, i: number) => `${v}:${i}`;
    const hashers = new Map<string, EventHasher>();
    const buffers = new Map<string, TownEvent[]>();
    const flush = async (v: Variant, i: number) => {
      const buf = buffers.get(key(v, i));
      if (!buf?.length) return;
      buffers.set(key(v, i), []);
      await appendEvents(ws, run.id, v, i, buf);
    };
    const out = await runScenarios({
      runId: run.id,
      layout,
      residents,
      personas,
      scenarios,
      days: run.days,
      seeds: run.seeds,
      baseSeed: run.baseSeed,
      decider,
      signal: abort.signal,
      record: (_v, i) => ({ events: i === 0, snapshots: i === 0 }),
      onEvent: (v, i, e) => {
        const k = key(v, i);
        let h = hashers.get(k);
        if (!h) hashers.set(k, (h = new EventHasher()));
        h.add(e);
        if (i === 0 || KEEP_FOR_OTHER_SEEDS.has(e.type)) {
          let b = buffers.get(k);
          if (!b) buffers.set(k, (b = []));
          b.push(e);
        }
      },
      onDay: async (v, i, day) => {
        await flush(v, i);
        const spend = ledger.spend(run.id);
        const now = await scoped((tx) => tx.simRun.update({ where: { id: run.id }, data: { progress: { variant: v, seedIndex: i, day, of: { days: run.days, seeds: run.seeds } }, spentCredits: spend.spentCredits, callCount: spend.callCount }, select: { status: true } }));
        if (now.status === "cancelled") abort.abort(new Error("cancelled"));
      },
      onSubRun: async (sub) => {
        await flush(sub.variant, sub.seedIndex);
        if (sub.seedIndex === 0 && sub.result) await insertSnapshots(ws, run.id, sub.variant, 0, sub.result.snapshots);
        if (sub.result) sub.result.snapshots = [];
      },
    });

    // ── report ───────────────────────────────────────────────────────────
    const store = new PgMemoryStore(ws, { embed: lexicalTestEmbedder });
    const interviewChunks = new Map<string, Array<{ transcriptId: string; content: string }>>();
    for (const p of personas) {
      const chunks: Array<{ transcriptId: string; content: string }> = [];
      for (const tid of p.spec.sourceTranscriptIds.slice(0, 10)) for (const n of await store.transcriptNodes(tid, ["interview"])) chunks.push({ transcriptId: tid, content: n.content });
      interviewChunks.set(p.id, chunks);
    }
    const report = buildTownReport({
      scenarios,
      subRuns: out.subRuns,
      stopped: out.stopped,
      residents,
      segments: (run.segments as unknown as import("./residents").SegmentSpec[]) ?? [],
      personas,
      calibration: await workspaceCalibration(ws),
      interviewChunks,
      modelKind: run.mode === "rules" ? "rules" : (run.modelKind as "live" | "fake"),
      days: run.days,
    });
    const spend = ledger.spend(run.id);
    const cancelled = out.stopped?.reason === "aborted";
    const status = cancelled ? "cancelled" : out.stopped ? "partial" : "completed";
    const eventHashes = Object.fromEntries([...hashers.entries()].map(([k, h]) => [k, h.digest()]));
    await scoped((tx) =>
      tx.simRun.update({
        where: { id: run.id },
        data: {
          status,
          stopReason: out.stopped ? (cancelled ? "cancelled" : out.stopped.reason) : null,
          ...(out.stopped ? { stoppedAt: out.stopped as unknown as Prisma.InputJsonValue } : {}),
          spentCredits: spend.spentCredits,
          callCount: spend.callCount,
          cacheHits: cache.hits,
          report: report as unknown as Prisma.InputJsonValue,
          eventHashes,
          progress: { done: true, decisions: out.subRuns.reduce((acc, s) => ({ model: acc.model + (s.result?.decisions.model ?? 0), cache: acc.cache + (s.result?.decisions.cache ?? 0), rules: acc.rules + (s.result?.decisions.rules ?? 0) }), { model: 0, cache: 0, rules: 0 }), residentDays: out.subRuns.reduce((n, s) => n + (s.result?.residentDays ?? 0), 0) },
          finishedAt: new Date(),
        },
      }),
    );
    return { status };
  } catch (err) {
    return fail(err);
  }
}
