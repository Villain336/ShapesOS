// ShapesOS — Phase 19B (WS=engine): the town rehearsal service.
// Commercial layer (entitlement dress_rehearsal). Architecture: lib/sim/engine.ts.
//
// One entry point for the routes, the Town tab and the agent tools, so every
// path goes through the same gates as the panel (lib/panel/service.server.ts
// gate(): the dress_rehearsal entitlement — Pro and above, a 403 with the
// upgrade message otherwise — then the workspace role: viewers read, editors
// change), FORCE RLS on every row, and — for anything that calls a model —
// an estimate first and a hard credit cap the person explicitly confirmed.
// A run is a `town_run` job on the agent worker (lib/sim/run.server.ts); at
// most MAX_LIVE_TOWN_RUNS per workspace are queued or running at once
// (Phase 16-style caps).

import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { HttpError } from "@/lib/api/errors";
import { blobPut, workspaceBlobPath } from "@/lib/filesystem/storage";
import { gate, listPersonas, type PanelActor } from "@/lib/panel/service.server";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import type { SimDeps } from "./deps.server";
import { estimateTownRun, type TownEstimate } from "./estimate";
import { fetchFigmaFrame, figmaFrameToLayout, FigmaImportError, parseFigmaUrl } from "./figma";
import { generateTown } from "./generate";
import { lotCapacity, parseTownLayout, type TownLayout } from "./layout";
import { generateResidents, type PersonaSeed, type SegmentSpec } from "./residents";
import type { TownReport } from "./results";
import { MAX_RUN_DAYS, ScenarioSchema, type Scenario } from "./scenario";
import { createWorld, eventsAfter, insertResidents } from "./store.server";

export const MAX_LIVE_TOWN_RUNS = 1;
export const POPULATION_BOUNDS = [50, 500] as const;
export const SEED_BOUNDS = [1, 10] as const;

const scoped = <T>(actor: PanelActor, fn: Parameters<typeof withWorkspaceScope<T>>[1]) => withWorkspaceScope(actor.workspaceId, fn);

// ---------------------------------------------------------------------------
// Worlds
// ---------------------------------------------------------------------------

export interface WorldView {
  id: string;
  name: string;
  source: "generated" | "figma";
  size: string | null;
  seed: number | null;
  homesFor: number;
  layout: TownLayout;
  createdAt: string;
}

function worldView(r: { id: string; name: string; source: string; size: string | null; seed: number | null; layout: unknown; createdAt: Date }): WorldView {
  const layout = r.layout as TownLayout;
  return {
    id: r.id,
    name: r.name,
    source: r.source === "figma" ? "figma" : "generated",
    size: r.size,
    seed: r.seed,
    homesFor: layout.lots.filter((l) => l.kind === "home").reduce((n, l) => n + lotCapacity(l), 0),
    layout,
    createdAt: r.createdAt.toISOString(),
  };
}

export async function listWorlds(actor: PanelActor): Promise<WorldView[]> {
  await gate(actor, "viewer");
  const rows = await scoped(actor, (tx) => tx.simWorld.findMany({ where: { workspaceId: actor.workspaceId }, orderBy: { createdAt: "desc" }, take: 50 }));
  return rows.map(worldView);
}

export async function createGeneratedWorld(actor: PanelActor, input: { size: "small" | "medium"; seed?: number; name?: string }): Promise<WorldView> {
  await gate(actor, "editor");
  const seed = Number.isInteger(input.seed) ? (input.seed as number) >>> 0 : Math.floor(Math.random() * 1_000_000);
  const layout = generateTown({ seed, size: input.size === "medium" ? "medium" : "small", name: input.name?.trim() || undefined });
  const row = await createWorld(actor.workspaceId, { name: layout.name, source: "generated", seed, size: input.size, layout, createdBy: actor.userId });
  return worldView(row);
}

export async function importFigmaWorld(actor: PanelActor, input: { url: string; name?: string; metresPerPixel?: number }, deps: Pick<SimDeps, "figmaToken" | "fetch">): Promise<WorldView> {
  await gate(actor, "editor");
  const ref = parseFigmaUrl(input.url);
  if (!ref) throw new HttpError(400, "Paste a Figma frame link (figma.com/design/…?node-id=…).");
  try {
    const frame = await fetchFigmaFrame(ref, { token: deps.figmaToken(), fetch: deps.fetch });
    const layout = figmaFrameToLayout(frame, { metresPerPixel: input.metresPerPixel });
    if (input.name?.trim()) layout.name = input.name.trim().slice(0, 120);
    const row = await createWorld(actor.workspaceId, { name: layout.name, source: "figma", figmaFileKey: ref.fileKey, figmaNodeId: ref.nodeId, layout, createdBy: actor.userId });
    return worldView(row);
  } catch (err) {
    if (err instanceof FigmaImportError) throw new HttpError(422, err.message);
    if (err instanceof Error && err.name === "TownLayoutError") throw new HttpError(422, err.message);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Run input
// ---------------------------------------------------------------------------

const SegmentSchema = z.object({
  key: z.string().trim().min(1).max(40),
  label: z.string().trim().min(1).max(80),
  share: z.number().min(0).max(1),
  personaId: z.string().max(64).nullish(),
  routineMix: z.object({ weekday: z.number().min(0).max(1).optional(), weekend: z.number().min(0).max(1).optional(), night: z.number().min(0).max(1).optional() }).optional(),
  income: z.enum(["low", "mid", "high"]).optional(),
  priceSensitivity: z.number().min(0).max(1).optional(),
  adOpenness: z.number().min(0).max(1).optional(),
});

export const TownRunInputSchema = z.object({
  worldId: z.string().min(1).max(64),
  population: z.number().int().min(POPULATION_BOUNDS[0]).max(POPULATION_BOUNDS[1]),
  segments: z.array(SegmentSchema).max(12).default([]),
  days: z.number().int().min(1).max(MAX_RUN_DAYS),
  seeds: z.number().int().min(SEED_BOUNDS[0]).max(SEED_BOUNDS[1]),
  baseSeed: z.number().int().min(0).max(2_147_483_647).optional(),
  mode: z.enum(["live", "deep", "rules"]).default("live"),
  scenarioA: ScenarioSchema,
  scenarioB: ScenarioSchema.nullish(),
});
export type TownRunInput = z.input<typeof TownRunInputSchema>;
type ParsedInput = z.output<typeof TownRunInputSchema>;

function parseInput(raw: unknown): ParsedInput {
  const r = TownRunInputSchema.safeParse(raw);
  if (!r.success) throw new HttpError(400, `Check the run setup: ${r.error.issues.slice(0, 4).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
  return r.data;
}

interface Prepared {
  input: ParsedInput;
  world: WorldView;
  personas: PersonaSeed[];
  residentsSeed: number;
}

async function prepare(actor: PanelActor, raw: unknown): Promise<Prepared> {
  const input = parseInput(raw);
  const row = await scoped(actor, (tx) => tx.simWorld.findFirst({ where: { id: input.worldId, workspaceId: actor.workspaceId } }));
  if (!row) throw new HttpError(404, "That town wasn't found.");
  const world = worldView(row);
  if (input.population > world.homesFor) throw new HttpError(400, `This town only has homes for ${world.homesFor} residents.`);
  const lotIds = new Map(world.layout.lots.map((l) => [l.id, l.kind]));
  for (const sc of [input.scenarioA, input.scenarioB].filter(Boolean) as Scenario[]) {
    for (const iv of sc.interventions) {
      if (iv.kind === "new_location" && !["shop", "cafe", "work"].includes(lotIds.get(iv.lotId) ?? "")) throw new HttpError(400, `A new location must be a shop, café or office lot of this town (${iv.lotId} isn't).`);
      if (iv.kind !== "ad_campaign" && iv.day >= input.days) throw new HttpError(400, `"${iv.kind.replace("_", " ")}" starts on day ${iv.day + 1}, after the run ends (day ${input.days}).`);
    }
  }
  const all = await listPersonas(actor);
  const wanted = new Set(input.segments.map((s) => s.personaId).filter(Boolean) as string[]);
  const personas: PersonaSeed[] = all.filter((p) => wanted.has(p.id) && p.status === "active").map((p) => ({ id: p.id, spec: p.spec, calibrated: p.calibrated }));
  for (const id of wanted) if (!personas.some((p) => p.id === id)) throw new HttpError(400, "A segment names a persona that doesn't exist or was vetoed.");
  return { input, world, personas, residentsSeed: input.baseSeed ?? 1 };
}

export interface TownEstimateView {
  estimate: TownEstimate;
  model: string;
  modelKind: "live" | "fake" | "rules";
  mode: "live" | "deep" | "rules";
  calibratedResidentsShare: number;
}

export async function estimateTown(actor: PanelActor, raw: unknown, deps: Pick<SimDeps, "pricingModel">): Promise<TownEstimateView> {
  await gate(actor, "viewer");
  const p = await prepare(actor, raw);
  const residents = generateResidents({ layout: p.world.layout, population: p.input.population, segments: p.input.segments as SegmentSpec[], personas: p.personas, seed: p.residentsSeed });
  const pricing = p.input.mode === "rules" ? { model: "rules", kind: "rules" as const } : await deps.pricingModel(actor.workspaceId);
  const estimate = await estimateTownRun({ layout: p.world.layout, residents, personas: p.personas, scenarios: { A: p.input.scenarioA, B: p.input.scenarioB ?? null }, days: p.input.days, seeds: p.input.seeds, baseSeed: p.input.baseSeed ?? 1, model: pricing.kind === "rules" ? "claude-haiku-4-5" : pricing.model });
  if (pricing.kind === "rules") Object.assign(estimate, { capCredits: 0, expectedCredits: 0, expectedCalls: 0 });
  return { estimate, model: pricing.model, modelKind: pricing.kind, mode: p.input.mode, calibratedResidentsShare: residents.filter((r) => r.calibrated).length / residents.length };
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export interface TownRunView {
  id: string;
  worldId: string;
  status: string;
  mode: string;
  scenarioA: Scenario;
  scenarioB: Scenario | null;
  population: number;
  days: number;
  seeds: number;
  baseSeed: number;
  model: string;
  modelKind: string;
  estimateCredits: number;
  capCredits: number;
  spentCredits: number;
  callCount: number;
  cacheHits: number;
  stopReason: string | null;
  stoppedAt: unknown;
  progress: unknown;
  report: TownReport | null;
  eventHashes: Record<string, string> | null;
  exportRef: string | null;
  replayOf: string | null;
  createdAt: string;
  finishedAt: string | null;
}

type RunRow = Prisma.SimRunGetPayload<object>;

function runView(r: RunRow): TownRunView {
  return {
    id: r.id,
    worldId: r.worldId,
    status: r.status,
    mode: r.mode,
    scenarioA: r.scenarioA as Scenario,
    scenarioB: (r.scenarioB as Scenario | null) ?? null,
    population: r.population,
    days: r.days,
    seeds: r.seeds,
    baseSeed: r.baseSeed,
    model: r.model,
    modelKind: r.modelKind,
    estimateCredits: r.estimateCredits,
    capCredits: r.capCredits,
    spentCredits: r.spentCredits,
    callCount: r.callCount,
    cacheHits: r.cacheHits,
    stopReason: r.stopReason,
    stoppedAt: r.stoppedAt,
    progress: r.progress,
    report: (r.report as TownReport | null) ?? null,
    eventHashes: (r.eventHashes as Record<string, string> | null) ?? null,
    exportRef: r.exportRef,
    replayOf: r.replayOf,
    createdAt: r.createdAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
  };
}

const ConfirmSchema = z.object({ capCredits: z.number().int().min(0).max(10_000_000), confirmed: z.literal(true, { error: "Confirm the estimate and the credit cap first." }) });

async function assertRoomForRun(actor: PanelActor): Promise<void> {
  const live = await scoped(actor, (tx) => tx.simRun.count({ where: { workspaceId: actor.workspaceId, status: { in: ["queued", "running"] } } }));
  if (live >= MAX_LIVE_TOWN_RUNS) throw new HttpError(409, "A town rehearsal is already running in this workspace. Wait for it to finish or cancel it.");
}

async function createRun(actor: PanelActor, p: Prepared, est: TownEstimateView, capCredits: number, deps: Pick<SimDeps, "enqueueRun">, replayOf: string | null): Promise<TownRunView> {
  const residents = generateResidents({ layout: p.world.layout, population: p.input.population, segments: p.input.segments as SegmentSpec[], personas: p.personas, seed: p.residentsSeed });
  const run = await scoped(actor, (tx) =>
    tx.simRun.create({
      data: {
        workspaceId: actor.workspaceId,
        worldId: p.world.id,
        mode: p.input.mode,
        scenarioA: p.input.scenarioA as unknown as Prisma.InputJsonValue,
        ...(p.input.scenarioB ? { scenarioB: p.input.scenarioB as unknown as Prisma.InputJsonValue } : {}),
        population: p.input.population,
        segments: p.input.segments as unknown as Prisma.InputJsonValue,
        personaSnapshot: p.personas as unknown as Prisma.InputJsonValue,
        days: p.input.days,
        seeds: p.input.seeds,
        baseSeed: p.input.baseSeed ?? 1,
        model: est.model,
        modelKind: est.modelKind,
        estimate: est.estimate as unknown as Prisma.InputJsonValue,
        estimateCredits: est.estimate.expectedCredits,
        capCredits,
        replayOf,
        confirmedBy: actor.userId,
      },
    }),
  );
  await insertResidents(actor.workspaceId, run.id, residents);
  const jobId = await deps.enqueueRun(actor.workspaceId, run.id);
  const updated = await scoped(actor, (tx) => tx.simRun.update({ where: { id: run.id }, data: { jobId } }));
  return runView(updated);
}

/** Start a run: the estimate is recomputed server-side and the person's confirmed cap is stored. */
export async function startTownRun(actor: PanelActor, raw: unknown, deps: Pick<SimDeps, "pricingModel" | "enqueueRun">): Promise<TownRunView> {
  await gate(actor, "editor");
  const c = ConfirmSchema.safeParse(raw);
  if (!c.success) throw new HttpError(400, c.error.issues[0]?.message ?? "Confirm the estimate and the credit cap first.");
  const p = await prepare(actor, raw);
  await assertRoomForRun(actor);
  const est = await estimateTown(actor, raw, deps);
  if (est.modelKind !== "rules" && c.data.capCredits < 1) throw new HttpError(400, "The credit cap must be at least 1 credit.");
  return createRun(actor, p, est, c.data.capCredits, deps, null);
}

/** Replay from seed: the same inputs, answered from the run's recorded decisions first. */
export async function replayTownRun(actor: PanelActor, runId: string, raw: unknown, deps: Pick<SimDeps, "pricingModel" | "enqueueRun">): Promise<TownRunView> {
  await gate(actor, "editor");
  const c = ConfirmSchema.safeParse(raw);
  if (!c.success) throw new HttpError(400, c.error.issues[0]?.message ?? "Confirm the credit cap first.");
  const src = await scoped(actor, (tx) => tx.simRun.findFirst({ where: { id: runId, workspaceId: actor.workspaceId } }));
  if (!src) throw new HttpError(404, "That run wasn't found.");
  const segments = src.segments as unknown as SegmentSpec[];
  const input = { worldId: src.worldId, population: src.population, segments, days: src.days, seeds: src.seeds, baseSeed: src.baseSeed, mode: src.mode, scenarioA: src.scenarioA, scenarioB: src.scenarioB ?? null };
  const p = await prepare(actor, input);
  // The personas as they were when the original was confirmed.
  p.personas = (src.personaSnapshot as unknown as PersonaSeed[]) ?? [];
  await assertRoomForRun(actor);
  const est = await estimateTown(actor, input, deps);
  est.estimate.expectedCalls = 0;
  est.estimate.expectedCredits = 0;
  return createRun(actor, p, est, c.data.capCredits, deps, src.id);
}

export async function listTownRuns(actor: PanelActor, limit = 30): Promise<TownRunView[]> {
  await gate(actor, "viewer");
  const rows = await scoped(actor, (tx) => tx.simRun.findMany({ where: { workspaceId: actor.workspaceId }, orderBy: { createdAt: "desc" }, take: Math.min(100, Math.max(1, limit)) }));
  return rows.map(runView);
}

export async function getTownRun(actor: PanelActor, id: string): Promise<TownRunView> {
  await gate(actor, "viewer");
  const row = await scoped(actor, (tx) => tx.simRun.findFirst({ where: { id, workspaceId: actor.workspaceId } }));
  if (!row) throw new HttpError(404, "That run wasn't found.");
  return runView(row);
}

export async function cancelTownRun(actor: PanelActor, id: string): Promise<TownRunView> {
  await gate(actor, "editor");
  const row = await scoped(actor, async (tx) => {
    const r = await tx.simRun.findFirst({ where: { id, workspaceId: actor.workspaceId } });
    if (!r) throw new HttpError(404, "That run wasn't found.");
    if (r.status !== "queued" && r.status !== "running") return r;
    return tx.simRun.update({ where: { id }, data: { status: "cancelled", stopReason: "cancelled", finishedAt: new Date() } });
  });
  return runView(row);
}

/** The run's residents (who is on the map): key, name, group, home. */
export async function listRunResidents(actor: PanelActor, runId: string): Promise<Array<{ id: string; name: string; segment: string; homeLotId: string; calibrated: boolean }>> {
  await gate(actor, "viewer");
  const rows = await scoped(actor, (tx) => tx.simResident.findMany({ where: { runId, workspaceId: actor.workspaceId }, orderBy: { residentKey: "asc" }, select: { residentKey: true, name: true, segment: true, homeLotId: true, calibrated: true } }));
  return rows.map((r) => ({ id: r.residentKey, name: r.name, segment: r.segment, homeLotId: r.homeLotId, calibrated: r.calibrated }));
}

export interface ResidentLog {
  resident: { key: string; name: string; segment: string; calibrated: boolean; personaId: string | null; homeLotId: string; workLotId: string; routine: string };
  /** Decisions, reflections, visits and purchases of seed 0, in order — their thought log. */
  entries: Array<{ t: number; type: string; text: string }>;
}

/** Follow a resident: their thought log in one scenario (seed 0, the one the map plays). */
export async function residentLog(actor: PanelActor, runId: string, residentKey: string, variant: "A" | "B" = "A"): Promise<ResidentLog> {
  await gate(actor, "viewer");
  const r = await scoped(actor, (tx) => tx.simResident.findFirst({ where: { runId, residentKey, workspaceId: actor.workspaceId } }));
  if (!r) throw new HttpError(404, "That resident wasn't found.");
  const events = await eventsAfter(actor.workspaceId, runId, variant, 0, -1, 2_000, { residentKey, types: ["decision", "reflect", "visit", "buy", "adopt", "ad", "mention"] });
  const entries = events
    .filter((e) => !(e.type === "buy" && !(e.d as { yours?: boolean })?.yours))
    .map((e) => {
      const d = (e.d ?? {}) as Record<string, unknown>;
      const v = (d.value ?? {}) as Record<string, unknown>;
      const text =
        e.type === "decision"
          ? `${String(d.point)}: ${String(v.thought ?? v.summary ?? "")}${v.objection ? ` (objection: ${String(v.objection)})` : ""}`
          : e.type === "reflect"
            ? `Reflection: ${String(d.summary)} → plan: ${String(d.plan).replace("_", " ")}`
            : e.type === "ad"
              ? `Saw a ${String(d.channel)} ad`
              : e.type === "mention"
                ? `Told ${String(d.to)} about it`
                : e.type === "buy"
                  ? `Bought it ($${(Number(d.cents) / 100).toFixed(2)})`
                  : e.type === "adopt"
                    ? "First purchase"
                    : `Visited ${e.lot ?? "the store"}`;
      return { t: e.t, type: e.type, text };
    });
  return { resident: { key: r.residentKey, name: r.name, segment: r.segment, calibrated: r.calibrated, personaId: r.personaId, homeLotId: r.homeLotId, workLotId: r.workLotId, routine: r.routine }, entries };
}

/** The exportable report: JSON in blob storage (namespace "rehearsal"); the run keeps the ref. */
export async function exportTownRun(actor: PanelActor, id: string): Promise<{ ref: string; filename: string; report: TownReport }> {
  await gate(actor, "viewer");
  const run = await getTownRun(actor, id);
  if (!run.report) throw new HttpError(409, "This run has no report yet.");
  const filename = `town-rehearsal-${run.id}.json`;
  const body = JSON.stringify({ exportedAt: new Date().toISOString(), synthetic: true, banner: run.report.banner, run: { ...run, report: undefined }, report: run.report }, null, 2);
  const ref = await blobPut("rehearsal", workspaceBlobPath(actor.workspaceId, "town", run.id, filename), body, "application/json");
  await scoped(actor, (tx) => tx.simRun.update({ where: { id }, data: { exportRef: ref } }));
  return { ref, filename, report: run.report };
}
