// ShapesOS — Phase 19B (WS=panel): a page walk run on the agent worker.
// Commercial layer (entitlement dress_rehearsal). Licence boundary: CONTRIBUTING.md (open vs commercial; company-authored).
//
// The body of the `panel_run` agent job (lib/agents/queue/handlers.ts):
//   1. claim the run (queued → running). A run found already "running" is a
//      second claim after a crash: it is marked partial ("interrupted") and
//      never re-run, so credits are never spent twice;
//   2. the workspace live-run cap (Phase 16 style): another run of this
//      workspace working → defer (the handler re-queues the job);
//   3. one PanelLedger with the CONFIRMED cap; the model through the router
//      (metered), cached per run;
//   4. personas walk in parallel, at most panelLimits().maxParallelPerRun at a
//      time and never more browsers than the recorder allows; each step is
//      saved as it happens (screenshots to blob storage), each walk gets a
//      friction timeline and a verdict — or a withheld reason;
//   5. the report (distribution, traced objections, section heat, fixes) and
//      the spend (estimate vs actual) are written; the run ends "completed",
//      or "partial" (the cap stopped something: an honest partial result), or
//      "failed" with the reason.

import { blobPut } from "@/lib/filesystem/storage";
import { maxConcurrentRecordings, RecorderBusyError } from "@/lib/agents/runs/recorder";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { aggregateReport } from "./aggregate";
import { isCapReached, PanelLedger } from "./budget";
import type { PanelDeps } from "./deps.server";
import { panelLimits, runPool } from "./estimate";
import { CachedPanelModel, type PanelModel } from "./model";
import type { OpenedWalk } from "./browser.server";
import { landingPageSite, makePanelRequestGuard, siteFilesSite, type PanelTarget, type ServedSite } from "./targets";
import { buildTimeline, type FrictionTimeline } from "./timeline";
import { personaAdherenceHook, selfConsistencyHook } from "./trust";
import { verdictOrWithheld, type VerdictOutcome } from "./verdicts";
import { runWalkthrough, type WalkthroughResult, type WalkthroughStep } from "./walk";
import { PgMemoryStore } from "./store.server";
import type { PersonaSnapshot, RunReport } from "./service.server";

export type RunOutcomeStatus = "completed" | "partial" | "failed" | "deferred" | "skipped";

const BUSY_RETRY_MS = 1_000;
const BUSY_MAX_WAIT_MS = 10 * 60_000;

function safeKey(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
}

async function resolveTarget(workspaceId: string, target: PanelTarget): Promise<{ startUrl: string; served: ServedSite | null }> {
  if (target.kind === "url") return { startUrl: target.url, served: null };
  if (target.kind === "landing_page") {
    const d = await withWorkspaceScope(workspaceId, (tx) => tx.pageDraft.findFirst({ where: { id: target.pageDraftId, workspaceId }, select: { html: true, css: true, name: true } }));
    if (!d) throw new Error("The landing page this run walks no longer exists.");
    const site = landingPageSite(d);
    return { startUrl: `${site.origin}${site.entryPath}`, served: site };
  }
  const { prisma } = await import("@/lib/prisma");
  const owned = await prisma.site.findFirst({ where: { id: target.siteId, project: { workspaceId } }, select: { id: true } });
  if (!owned) throw new Error("The site this run walks no longer exists.");
  const { readSiteWorkingCopy } = await import("@/lib/sites/files");
  const { files } = await readSiteWorkingCopy(target.siteId);
  const site = siteFilesSite(files, target.path);
  return { startUrl: `${site.origin}${site.entryPath}`, served: site };
}

async function openWithRetry(deps: PanelDeps, opts: Parameters<PanelDeps["openPage"]>[0]): Promise<OpenedWalk> {
  const started = Date.now();
  for (;;) {
    try {
      return await deps.openPage(opts);
    } catch (err) {
      // Another recording holds the browser slot: wait for it (bounded).
      if (err instanceof RecorderBusyError && Date.now() - started < BUSY_MAX_WAIT_MS) {
        await new Promise((r) => setTimeout(r, BUSY_RETRY_MS));
        continue;
      }
      throw err;
    }
  }
}

function emptyResult(runId: string, p: PersonaSnapshot, outcome: WalkthroughResult["outcome"], stopReason: string): WalkthroughResult {
  return { runId, personaKey: p.key, personaName: p.name, outcome, steps: [], stopReason, signals: { totalDwellMs: 0, maxScrollDepthPct: 0, totalClicks: 0, rageClickBursts: 0, totalHoverDwellMs: 0, sectionsVisited: [], dropOff: { url: "" }, llmCalls: 0 } };
}

export async function runPanelRun(workspaceId: string, runId: string, deps: PanelDeps): Promise<{ status: RunOutcomeStatus }> {
  const scoped = <T>(fn: Parameters<typeof withWorkspaceScope<T>>[1]) => withWorkspaceScope(workspaceId, fn);
  const run = await scoped((tx) => tx.panelRun.findFirst({ where: { id: runId, workspaceId } }));
  if (!run) return { status: "skipped" };
  if (run.status === "running") {
    await scoped((tx) => tx.panelRun.update({ where: { id: runId }, data: { status: "partial", stopReason: "interrupted: the worker stopped during this run; it was not re-run, so no credits were spent twice.", finishedAt: new Date() } }));
    return { status: "partial" };
  }
  if (run.status !== "queued") return { status: "skipped" };
  const limits = panelLimits(process.env, maxConcurrentRecordings());
  const live = await scoped((tx) => tx.panelRun.count({ where: { workspaceId, status: "running", id: { not: runId } } }));
  if (live >= limits.maxLiveRunsPerWorkspace) return { status: "deferred" };
  await scoped((tx) => tx.panelRun.update({ where: { id: runId }, data: { status: "running", startedAt: new Date() } }));

  const ledger = new PanelLedger();
  ledger.beginRun(runId, run.capCredits);
  const personas = (run.personaSnapshot as unknown as PersonaSnapshot[]) ?? [];
  let model: PanelModel;
  let cached: CachedPanelModel;
  try {
    cached = new CachedPanelModel(await deps.modelFor(workspaceId, ledger, run.confirmedBy));
    model = cached;
  } catch (err) {
    await scoped((tx) => tx.panelRun.update({ where: { id: runId }, data: { status: "failed", stopReason: err instanceof Error ? err.message : String(err), finishedAt: new Date() } }));
    return { status: "failed" };
  }
  const store = new PgMemoryStore(workspaceId, { embed: deps.embed, createdBy: run.confirmedBy });

  let target: { startUrl: string; served: ServedSite | null };
  try {
    target = await resolveTarget(workspaceId, run.target as unknown as PanelTarget);
  } catch (err) {
    await scoped((tx) => tx.panelRun.update({ where: { id: runId }, data: { status: "failed", stopReason: err instanceof Error ? err.message : String(err), finishedAt: new Date() } }));
    return { status: "failed" };
  }
  const guard = makePanelRequestGuard({ checkUrl: deps.checkUrl, servedOrigin: target.served?.origin ?? null });

  const syncSpend = async () => {
    const s = ledger.spend(runId);
    await scoped((tx) => tx.panelRun.update({ where: { id: runId }, data: { spentCredits: s.spentCredits, callCount: s.callCount } }));
  };

  const walkOne = async (p: PersonaSnapshot): Promise<{ outcome: VerdictOutcome; timeline: FrictionTimeline; capStopped: boolean }> => {
    const prefix = `${workspaceId}/${safeKey(runId)}/${safeKey(p.key)}`;
    let result: WalkthroughResult;
    let traceRef: string | null = null;
    // A cap reached before this persona could start: it never walks.
    if (ledger.spend(runId).refusedCalls > 0) {
      result = emptyResult(runId, p, "cap-stopped", `Not started: the run reached its credit cap of ${run.capCredits}.`);
    } else {
      let opened: OpenedWalk | null = null;
      try {
        opened = await openWithRetry(deps, { walkKey: `${safeKey(runId)}-${safeKey(p.key)}`, startUrl: target.startUrl, served: target.served, guard });
        result = await runWalkthrough({
          model,
          store,
          personaSpec: p.spec,
          personaKey: p.key,
          page: opened.page,
          runId,
          stepCap: run.stepCap,
          humanTiming: deps.humanTiming,
          onStepHooks: [personaAdherenceHook({ model, personaSpec: p.spec, runId }), selfConsistencyHook({ model, runId })],
          saveShot: (i, verb, bytes) => blobPut("rehearsal", `${prefix}/step-${i}-${safeKey(verb)}.png`, bytes, "image/png"),
          onStep: async (step: WalkthroughStep) => {
            await scoped((tx) =>
              tx.panelStep.create({
                data: {
                  workspaceId,
                  runId,
                  personaKey: p.key,
                  personaName: p.name,
                  stepIndex: step.stepIndex,
                  intent: step.intent ?? undefined,
                  thinkAloud: step.thinkAloud,
                  observation: step.observation as object,
                  signals: step.signals as object,
                  flags: step.flags as object[],
                  screenshotRef: step.observation.screenshotRef ?? null,
                  startedAt: new Date(step.startedAt),
                  endedAt: new Date(step.endedAt),
                },
              }),
            );
            await syncSpend();
          },
        });
      } catch (err) {
        result = emptyResult(runId, p, isCapReached(err) ? "cap-stopped" : "failed", err instanceof Error ? err.message : String(err));
      } finally {
        if (opened) {
          const { traceBytes } = await opened.close().catch(() => ({ traceBytes: null }));
          if (traceBytes) traceRef = await blobPut("rehearsal", `${prefix}/trace.zip`, traceBytes, "application/zip").catch(() => null);
        }
      }
    }
    const timeline = buildTimeline(result);
    let outcome: VerdictOutcome;
    try {
      outcome = await verdictOrWithheld({ model, store, personaSpec: p.spec, result, timeline, runId });
    } catch (err) {
      if (!isCapReached(err)) throw err;
      outcome = { kind: "withheld", personaKey: p.key, personaName: p.name, reason: "incomplete_walk", detail: `Stopped at the credit cap before the verdict: ${(err as Error).message}` };
    }
    await scoped((tx) =>
      tx.panelVerdict.create({
        data: {
          workspaceId,
          runId,
          personaKey: p.key,
          personaName: p.name,
          outcome: result.outcome,
          ...(outcome.kind === "verdict"
            ? {
                verdict: outcome.verdict.verdict,
                confidence: outcome.verdict.confidence,
                rationale: outcome.verdict.rationale,
                objections: outcome.verdict.objections as unknown as object[],
                whatWouldChangeMind: outcome.verdict.whatWouldChangeMind,
                behaviorSummary: outcome.verdict.behaviorSummary,
              }
            : { withheldReason: outcome.reason, rationale: outcome.detail }),
          timeline: timeline as unknown as object,
          traceRef,
        },
      }),
    );
    await syncSpend();
    return { outcome, timeline, capStopped: result.outcome === "cap-stopped" || (outcome.kind === "withheld" && /credit cap/.test(outcome.detail)) };
  };

  try {
    const walked = await runPool(personas, limits.maxParallelPerRun, walkOne);
    const report = await aggregateReport({ outcomes: walked.map((w) => w.outcome), timelines: walked.map((w) => w.timeline), model, runId });
    const spend = ledger.spend(runId);
    const capStopped = walked.some((w) => w.capStopped) || report.fixesSkippedAtCap > 0;
    const failed = walked.filter((w) => w.timeline.outcome === "failed");
    const full: RunReport = {
      ...report,
      modelKind: model.kind,
      model: model.model,
      spend: { estimateCredits: run.estimateCredits, capCredits: run.capCredits, spentCredits: spend.spentCredits, calls: spend.callCount, byPurpose: ledger.spendByPurpose(runId), cacheHits: cached.stats().hits },
    };
    const status: RunOutcomeStatus = failed.length === personas.length && personas.length > 0 ? "failed" : capStopped || failed.length > 0 ? "partial" : "completed";
    const stopReason = capStopped
      ? `Stopped at the credit cap of ${run.capCredits}: ${spend.spentCredits} credits spent. The results below are partial.`
      : failed.length
        ? `${failed.length} of ${personas.length} walks failed: ${failed[0]!.outcome.kind === "withheld" ? failed[0]!.outcome.detail : ""}`.trim()
        : null;
    await scoped((tx) => tx.panelRun.update({ where: { id: runId }, data: { status, report: full as unknown as object, spentCredits: spend.spentCredits, callCount: spend.callCount, stopReason, finishedAt: new Date() } }));
    return { status };
  } catch (err) {
    const spend = ledger.spend(runId);
    await scoped((tx) => tx.panelRun.update({ where: { id: runId }, data: { status: "failed", stopReason: err instanceof Error ? err.message : String(err), spentCredits: spend.spentCredits, callCount: spend.callCount, finishedAt: new Date() } }));
    return { status: "failed" };
  }
}
