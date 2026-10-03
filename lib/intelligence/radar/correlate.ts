// Marketr — Phase 10 M2: correlation engine.
//
// For each CONFIRMED ROLLOUT event window, compares each connected property's
// GSC hourly deltas (pre-window baseline vs. during/post window) and writes
// per-page, per-query impact rows with magnitudes and confidence bands.
//
// Honesty rules (SPEC-PHASE10.md §M2):
//   - Only ROLLOUT events are correlated. docs_change / volatility never are.
//   - Only claim impact where the delta exceeds the baseline noise band.
//     The noise band is computed from the delta set itself: threshold =
//     median(|magnitude|) + 2×MAD. Everything below it is recorded as noise
//     and NOT written (a future M1 with per-day windows can tighten this).
//   - Confidence bands are honest intervals [lower, upper] around the impact
//     score — never a point score.
//   - Sign convention follows M1's contract: deltaPosition = post − pre, so
//     NEGATIVE deltaPosition = moved UP (improved).

import { withWorkspaceScope } from "@/lib/substrate/graph/rls";
import type {
  CorrelatedImpact,
  DateWindow,
  NoiseBand,
  PageQueryDelta,
} from "./types";

const DAY_MS = 86_400_000;
/** Pre-window: 7 days before the rollout begins. */
export const PRE_WINDOW_DAYS = 7;
/** Post-window: from rollout start through rollout end + 3 days of settle. */
export const POST_SETTLE_DAYS = 3;

export function buildWindows(event: {
  startedAt: Date | null;
  endedAt: Date | null;
}): { pre: DateWindow; post: DateWindow } | null {
  if (!event.startedAt) return null; // no dates → cannot correlate honestly
  const start = event.startedAt;
  const end = event.endedAt && event.endedAt > start ? event.endedAt : start;
  return {
    pre: { start: new Date(start.getTime() - PRE_WINDOW_DAYS * DAY_MS), end: start },
    post: { start, end: new Date(end.getTime() + POST_SETTLE_DAYS * DAY_MS) },
  };
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

/**
 * Baseline noise band over the delta set: threshold = median(|magnitude|)
 * + 2×MAD(|magnitude|) (MAD scaled by 1.4826 ≈ σ for normal data).
 * Degenerate case (MAD = 0): fall back to median + a small absolute floor so
 * a perfectly flat site never flags everything.
 */
export function computeNoiseBand(deltas: PageQueryDelta[]): NoiseBand {
  const mags = deltas.map((d) => Math.abs(d.magnitude));
  const med = median(mags);
  const mad = 1.4826 * median(mags.map((m) => Math.abs(m - med)));
  const threshold = mad > 0 ? med + 2 * mad : med + 5;
  return { median: med, mad, threshold, deltasConsidered: deltas.length };
}

/**
 * Impact score + honest band from a flagged delta's z-distance above the
 * noise threshold. score = 1 − exp(−z/2); the band widens when z is small
 * (uncertain) and tightens when z is large (clearly above noise).
 */
export function scoreWithBand(magnitude: number, band: NoiseBand): {
  impactScore: number;
  confidenceBand: [number, number];
} {
  const spread = band.mad > 0 ? band.mad : Math.max(5, band.median * 0.25);
  const z = Math.max(0, (magnitude - band.threshold) / spread);
  const score = 1 - Math.exp(-z / 2);
  const halfWidth = 0.5 / (1 + z);
  const lo = Math.max(0, score - halfWidth);
  const hi = Math.min(1, score + halfWidth);
  return { impactScore: round2(score), confidenceBand: [round2(lo), round2(hi)] };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function directionOf(d: PageQueryDelta): CorrelatedImpact["direction"] {
  // M1 sign convention: NEGATIVE deltaPosition = moved UP (improved).
  const clickSig = d.deltaClicks > 0 ? 1 : d.deltaClicks < 0 ? -1 : 0;
  const posSig = d.deltaPosition < 0 ? 1 : d.deltaPosition > 0 ? -1 : 0;
  const sum = clickSig + posSig;
  if (sum >= 1) return "improved";
  if (sum <= -1) return "declined";
  return "mixed";
}

/**
 * Flag page×query deltas that exceed the noise band. Pure function — the
 * unit-test surface. Returns impacts sorted by impactScore desc.
 */
export function flagImpacts(deltas: PageQueryDelta[]): {
  impacts: CorrelatedImpact[];
  band: NoiseBand;
} {
  const band = computeNoiseBand(deltas);
  const impacts: CorrelatedImpact[] = [];
  for (const d of deltas) {
    if (Math.abs(d.magnitude) < band.threshold) continue; // noise — not claimed
    const { impactScore, confidenceBand } = scoreWithBand(Math.abs(d.magnitude), band);
    impacts.push({
      projectId: d.projectId,
      page: d.page,
      query: d.query,
      deltaClicks: d.deltaClicks,
      deltaImpressions: d.deltaImpressions,
      deltaPosition: d.deltaPosition,
      impactScore,
      confidenceBand,
      direction: directionOf(d),
    });
  }
  impacts.sort((a, b) => b.impactScore - a.impactScore);
  return { impacts, band };
}

/** Idempotent write: replace this event×project's impacts inside one txn. */
export async function writeImpacts(
  workspaceId: string,
  platformEventId: string,
  impacts: CorrelatedImpact[],
): Promise<number> {
  return withWorkspaceScope(workspaceId, async (tx) => {
    const projectIds = [...new Set(impacts.map((i) => i.projectId))];
    if (projectIds.length > 0) {
      await tx.pageImpact.deleteMany({
        where: { workspaceId, platformEventId, projectId: { in: projectIds } },
      });
    }
    if (impacts.length === 0) return 0;
    await tx.pageImpact.createMany({
      data: impacts.map((i) => ({
        workspaceId,
        platformEventId,
        projectId: i.projectId,
        page: i.page.slice(0, 2000),
        query: i.query.slice(0, 500),
        deltaClicks: Math.round(i.deltaClicks),
        deltaImpressions: Math.round(i.deltaImpressions),
        impactScore: i.impactScore,
        confidenceBand: [i.confidenceBand[0], i.confidenceBand[1]],
      })),
    });
    return impacts.length;
  });
}

/** Read an event's stored impacts for the UI. */
export async function readImpacts(workspaceId: string, platformEventId: string) {
  return withWorkspaceScope(workspaceId, async (tx) =>
    tx.pageImpact.findMany({
      where: { workspaceId, platformEventId },
      orderBy: [{ impactScore: "desc" }],
      include: { project: { select: { domain: true } } },
    }),
  );
}
