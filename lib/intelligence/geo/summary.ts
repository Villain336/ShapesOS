// Marketr — Phase 10 M3: honest aggregation.
//
// Reads RAW geo_observation rows and produces the per-engine distribution
// tables the UI and API ship. Every number leaves this module carrying CI
// metadata (see honesty.ts) — a bare "AI visibility score" cannot be
// constructed from these outputs by design.

import { withWorkspaceScope, type TxClient } from "@/lib/substrate/graph/rls";
import {
  perEngineShare,
  nRepStability,
  leaderFlipRate,
  unstableShareReport,
  type HonestShare,
  type StabilityReport,
  type FlipRateReport,
  type UnstableShareReport,
} from "./honesty";
import {
  ownedCitationCoverage,
  detectCitationGaps,
  type CitationGap,
  type CitationObservation,
} from "./citations";
import { getPanel, GEO_ENGINES, type GeoEngine } from "./panels";

interface RawObservation {
  runAt: Date;
  rep: number;
  engine: string | null;
  brandMentioned: boolean;
  citationUrls: string[];
  promptIdx: number | null;
}

function engineOf(meta: unknown): string | null {
  if (meta && typeof meta === "object") {
    const m = meta as Record<string, unknown>;
    return typeof m.engine === "string" ? m.engine : null;
  }
  return null;
}

function promptIdxOf(meta: unknown): number | null {
  if (meta && typeof meta === "object") {
    const m = meta as Record<string, unknown>;
    return typeof m.promptIdx === "number" ? m.promptIdx : null;
  }
  return null;
}

export interface EngineDistribution {
  engine: GeoEngine;
  observations: number;
  prompts: number;
  reps: number;
  /** Brand-mention share with Wilson 95% CI — the headline "estimated range". */
  mentionShare: HonestShare;
  /** N-rep stability across reps. */
  stability: StabilityReport;
  /** Unmentioned-share with the >30% unstable flag. */
  unmentioned: UnstableShareReport;
  /** Owned-domain citation coverage with Wilson 95% CI. */
  ownedCitation: HonestShare;
  runs: number;
}

export interface GeoSummary {
  panelId: string;
  engine: string;
  promptSetVersion: number;
  promptCount: number;
  latestRunAt: string | null;
  runCount: number;
  perEngine: EngineDistribution[];
  /** Leader-flip rate across runs (null until ≥2 runs). */
  leaderFlips: FlipRateReport | null;
  citationGaps: CitationGap[];
  proxyDisclaimer: string;
  generatedAt: string;
}

/**
 * Summarize a panel's raw observations into per-engine distributions.
 * ownedDomain: the brand's domain for citation-coverage + gap analysis.
 */
export async function summarizePanel(
  workspaceId: string,
  panelId: string,
  ownedDomain: string,
): Promise<GeoSummary> {
  const panel = await getPanel(workspaceId, panelId);
  if (!panel) throw new Error(`Panel ${panelId} not found in workspace.`);

  const rows = await withWorkspaceScope(workspaceId, (tx: TxClient) =>
    tx.geoObservation.findMany({
      where: { workspaceId, panelId: panel.id },
      orderBy: { runAt: "asc" },
      select: {
        runAt: true,
        rep: true,
        brandMentioned: true,
        citationUrls: true,
        stabilityMetadata: true,
      },
    }),
  );

  const obs: RawObservation[] = rows.map((r) => ({
    runAt: r.runAt,
    rep: r.rep,
    engine: engineOf(r.stabilityMetadata),
    brandMentioned: r.brandMentioned,
    citationUrls: r.citationUrls,
    promptIdx: promptIdxOf(r.stabilityMetadata),
  }));

  const runKeys = [...new Set(obs.map((o) => o.runAt.toISOString()))].sort();
  const citObs: CitationObservation[] = obs.map((o) => ({
    promptIdx: o.promptIdx,
    engine: o.engine ?? "unknown",
    citationUrls: o.citationUrls,
    brandMentioned: o.brandMentioned,
  }));
  const coverageByEngine = new Map(
    ownedCitationCoverage(citObs, [ownedDomain]).map((c) => [c.engine, c]),
  );

  const perEngine: EngineDistribution[] = [];
  const leaders: Array<string | null> = [];
  for (const engine of GEO_ENGINES) {
    const eo = obs.filter((o) => o.engine === engine);
    if (eo.length === 0) continue;
    const mentioned = eo.filter((o) => o.brandMentioned).length;
    const prompts = new Set(eo.map((o) => o.promptIdx).filter((p): p is number => p !== null));
    const reps = new Set(eo.map((o) => o.rep));
    const runs = new Set(eo.map((o) => o.runAt.toISOString()));

    // Per-prompt stability: aggregate rep agreement across prompts.
    const byPrompt = new Map<number, boolean[]>();
    for (const o of eo) {
      if (o.promptIdx === null) continue;
      const arr = byPrompt.get(o.promptIdx) ?? [];
      arr.push(o.brandMentioned);
      byPrompt.set(o.promptIdx, arr);
    }
    const stabilities = [...byPrompt.values()].map(nRepStability);
    const stability: StabilityReport =
      stabilities.length > 0
        ? {
            honestMetric: true,
            stability:
              stabilities.reduce((n, s) => n + s.stability, 0) / stabilities.length,
            modalOutcome: stabilities[0].modalOutcome,
            flipRate:
              stabilities.reduce((n, s) => n + s.flipRate, 0) / stabilities.length,
            n: stabilities.reduce((n, s) => n + s.n, 0),
            confidenceInterval: [
              Math.min(...stabilities.map((s) => s.confidenceInterval[0])),
              Math.max(...stabilities.map((s) => s.confidenceInterval[1])),
            ],
            confidenceLevel: 0.95,
          }
        : nRepStability([]);

    perEngine.push({
      engine,
      observations: eo.length,
      prompts: prompts.size,
      reps: reps.size,
      mentionShare: perEngineShare(engine, mentioned, eo.length),
      stability,
      unmentioned: unstableShareReport(engine, eo.length - mentioned, eo.length),
      ownedCitation:
        coverageByEngine.get(engine) ?? perEngineShare(engine, 0, 0),
      runs: runs.size,
    });
  }

  // Leader per run = engine with the highest mention share that run.
  for (const rk of runKeys) {
    const runObs = obs.filter((o) => o.runAt.toISOString() === rk && o.engine);
    const byEngine = new Map<string, { m: number; n: number }>();
    for (const o of runObs) {
      const e = byEngine.get(o.engine as string) ?? { m: 0, n: 0 };
      e.n += 1;
      if (o.brandMentioned) e.m += 1;
      byEngine.set(o.engine as string, e);
    }
    let leader: string | null = null;
    let best = -1;
    for (const [e, { m, n }] of byEngine) {
      const s = n > 0 ? m / n : 0;
      if (s > best) {
        best = s;
        leader = e;
      }
    }
    leaders.push(leader);
  }

  const gaps = detectCitationGaps(citObs, [ownedDomain], panel.prompts);

  return {
    panelId: panel.id,
    engine: panel.engine,
    promptSetVersion: panel.promptSetVersion,
    promptCount: panel.prompts.length,
    latestRunAt: runKeys.length > 0 ? runKeys[runKeys.length - 1] : null,
    runCount: runKeys.length,
    perEngine,
    leaderFlips: leaders.length >= 2 ? leaderFlipRate(leaders) : null,
    citationGaps: gaps,
    proxyDisclaimer:
      "Official-API completions are a proxy of consumer surfaces, not the surfaces themselves. Per-engine estimated ranges are the metric — no composite score exists by design.",
    generatedAt: new Date().toISOString(),
  };
}
