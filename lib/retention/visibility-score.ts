// Marketr — composite visibility score (milestone 14).
//
// One 0–100 number per project per day, built from four components so the
// dashboard can show *why* the score moved:
//
//   rankings   (default 50%) — milestone 5's volume-weighted position score
//   aiPresence (default 20%) — % of tracked keywords where the site is cited
//                              in an AI answer (milestone 14 snapshots)
//   freshness  (default 15%) — % of tracked keywords with content touched in
//                              the last 90 days (content engine activity)
//   coverage   (default 15%) — % of tracked keywords ranking at all in the
//                              latest check (checked depth)
//
// Weights are configurable per workspace (Workspace.visibilityWeights JSON);
// missing keys fall back to defaults and the set is normalized to sum to 1.
// The daily cron upserts one row per project per day and emits
// `visibility_delta` (milestone 13 trigger) on week-over-week movement.
//
// NOTE (milestone 15): a `backlinks` component (link-profile quality) is
// RESERVED for a later milestone. Do not add it until the backlink quality
// signal is calibrated — the raw counts in backlink_summaries are not yet a
// trustworthy 0–100 signal. Schema comment on Workspace.visibilityWeights
// carries the same note.

import { prisma } from "@/lib/prisma";
import { visibilityScore as rankingsScore } from "@/lib/rankings";

export interface ScoreWeights {
  rankings: number;
  aiPresence: number;
  freshness: number;
  coverage: number;
}

export const DEFAULT_WEIGHTS: ScoreWeights = {
  rankings: 0.5,
  aiPresence: 0.2,
  freshness: 0.15,
  coverage: 0.15,
};

export interface ScoreComponents {
  rankings: number;
  aiPresence: number;
  freshness: number;
  coverage: number;
  weights: ScoreWeights;
}

/** Merge workspace overrides over defaults; normalize to sum 1. */
export function resolveWeights(raw: unknown): ScoreWeights {
  const o = (raw ?? {}) as Partial<Record<keyof ScoreWeights, unknown>>;
  const merged: ScoreWeights = {
    rankings: typeof o.rankings === "number" && o.rankings >= 0 ? o.rankings : DEFAULT_WEIGHTS.rankings,
    aiPresence: typeof o.aiPresence === "number" && o.aiPresence >= 0 ? o.aiPresence : DEFAULT_WEIGHTS.aiPresence,
    freshness: typeof o.freshness === "number" && o.freshness >= 0 ? o.freshness : DEFAULT_WEIGHTS.freshness,
    coverage: typeof o.coverage === "number" && o.coverage >= 0 ? o.coverage : DEFAULT_WEIGHTS.coverage,
  };
  const total = merged.rankings + merged.aiPresence + merged.freshness + merged.coverage;
  if (total <= 0) return { ...DEFAULT_WEIGHTS };
  const r = (x: number) => Math.round((x / total) * 1000) / 1000;
  return { rankings: r(merged.rankings), aiPresence: r(merged.aiPresence), freshness: r(merged.freshness), coverage: r(merged.coverage) };
}

export async function getWeights(workspaceId: string): Promise<ScoreWeights> {
  const ws = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { visibilityWeights: true },
  });
  return resolveWeights(ws?.visibilityWeights);
}

/** Pure combination of the four 0–100 components into the final score. */
export function combineScore(components: ScoreComponents): number {
  const w = components.weights;
  return Math.round(
    w.rankings * components.rankings +
      w.aiPresence * components.aiPresence +
      w.freshness * components.freshness +
      w.coverage * components.coverage,
  );
}

const FRESHNESS_WINDOW_DAYS = 90;

/** Compute today's components for a project (DB reads, no writes). */
export async function computeComponents(
  project: { id: string; workspaceId: string },
  weights: ScoreWeights,
): Promise<ScoreComponents> {
  const keywords = await prisma.keyword.findMany({
    where: { projectId: project.id, tracked: true },
    select: { id: true, volume: true },
  });
  const keywordIds = keywords.map((k) => k.id);

  // Latest ranking per keyword.
  const latestRankings = keywordIds.length
    ? await prisma.ranking.findMany({
        where: { keywordId: { in: keywordIds } },
        orderBy: { checkedAt: "desc" },
        distinct: ["keywordId"],
        select: { keywordId: true, position: true },
      })
    : [];
  const posByKeyword = new Map(latestRankings.map((r) => [r.keywordId, r.position]));

  const rankings = rankingsScore(
    keywords.map((k) => ({ volume: k.volume, position: posByKeyword.get(k.id) ?? null })),
  );

  // AI presence: share of tracked keywords with site cited in latest AI snapshot.
  const latestAi = keywordIds.length
    ? await prisma.aIVisibilitySnapshot.findMany({
        where: { keywordId: { in: keywordIds } },
        orderBy: { checkedAt: "desc" },
        distinct: ["keywordId"],
        select: { keywordId: true, siteCited: true },
      })
    : [];
  const aiPresence =
    keywords.length === 0
      ? 0
      : Math.round((100 * latestAi.filter((s) => s.siteCited).length) / keywords.length);

  // Freshness: share of tracked keywords with content updated in the window.
  const freshSince = new Date(Date.now() - FRESHNESS_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const freshItems = keywordIds.length
    ? await prisma.contentItem.findMany({
        where: { keywordId: { in: keywordIds }, updatedAt: { gte: freshSince } },
        select: { keywordId: true },
        distinct: ["keywordId"],
      })
    : [];
  const freshness =
    keywords.length === 0
      ? 0
      : Math.round((100 * freshItems.length) / keywords.length);

  // Coverage: share of tracked keywords ranking at all in the latest check.
  const ranked = [...posByKeyword.values()].filter((p) => p != null && p > 0).length;
  const coverage =
    keywords.length === 0 ? 0 : Math.round((100 * ranked) / keywords.length);

  return { rankings, aiPresence, freshness, coverage, weights };
}

export interface Emitter {
  (input: {
    workspaceId: string;
    projectId: string;
    trigger: string;
    severity: "info" | "warn" | "critical";
    title: string;
    body: string;
    link: string;
    delta?: number;
    dedupKey?: string;
  }): Promise<unknown>;
}

/** Day bucket (UTC midnight) for the time series. */
export function dayBucket(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * Compute and store today's visibility score for a project, then compare
 * against the score from ~7 days ago and emit `visibility_delta` so
 * milestone 13 rules can route week-over-week moves.
 */
export async function computeAndStoreScore(
  project: { id: string; workspaceId: string; domain: string },
  emit: Emitter,
  audit: (summary: string) => Promise<void>,
  opts: { mock?: boolean; now?: Date } = {},
): Promise<{ score: number; components: ScoreComponents; delta: number | null }> {
  const now = opts.now ?? new Date();
  const date = dayBucket(now);
  const weights = await getWeights(project.workspaceId);
  const components = await computeComponents(project, weights);
  const score = combineScore(components);

  await prisma.visibilityScore.upsert({
    where: { projectId_date: { projectId: project.id, date } },
    create: {
      projectId: project.id,
      date,
      score,
      components: components as unknown as object,
      mock: opts.mock ?? false,
    },
    update: { score, components: components as unknown as object },
  });

  await audit(`Visibility score computed for ${project.domain}: ${score}/100`).catch(() => {});

  // Week-over-week delta: latest score on/before 7 days ago.
  const weekAgo = new Date(date.getTime() - 7 * 24 * 60 * 60 * 1000);
  const baseline = await prisma.visibilityScore.findFirst({
    where: { projectId: project.id, date: { lt: date, gte: new Date(weekAgo.getTime() - 3 * 24 * 60 * 60 * 1000) } },
    orderBy: { date: "desc" },
    select: { score: true, date: true },
  });
  let delta: number | null = null;
  if (baseline) {
    delta = score - baseline.score;
    if (delta !== 0) {
      const dayKey = now.toISOString().slice(0, 10);
      const dir = delta > 0 ? "up" : "down";
      try {
        await emit({
          workspaceId: project.workspaceId,
          projectId: project.id,
          trigger: "visibility_delta",
          severity: Math.abs(delta) >= 15 ? "warn" : "info",
          title: `📊 Visibility score ${dir} ${Math.abs(delta)} pts WoW (${baseline.score} → ${score})`,
          body: `${project.domain} composite visibility score moved ${dir} ${Math.abs(delta)} points week-over-week.\nComponents — rankings ${components.rankings}, AI presence ${components.aiPresence}, freshness ${components.freshness}, coverage ${components.coverage}.`,
          link: `/dashboard/projects/${project.id}`,
          delta,
          dedupKey: `visibility_delta:${project.id}:${dayKey}`,
        });
      } catch {
        // alert failures never break scoring
      }
    }
  }

  return { score, components, delta };
}
