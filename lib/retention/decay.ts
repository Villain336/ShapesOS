// Marketr — content decay & refresh engine (milestone 14).
//
// Decay is computed from a keyword's ranking history (no new paid API
// calls — pure local computation). Findings are grouped per ranking URL so
// the dashboard shows "this page is decaying" rather than scattered
// keyword rows.
//
// Decay score formula (0–100), designed to be explainable in the UI:
//   - No ranked history → 0 (nothing to decay from).
//   - Dropped out of the checked depth entirely → 100 if it used to rank
//     top 10 (a page that fell off page 1), else 80.
//   - Otherwise drop = current − peak (positions lost; ≤2 positions of
//     movement is noise → 0). Multiplied by how valuable the peak was:
//     losing #1 hurts more than losing #50.
//       multiplier = 8 (peak ≤ 3) | 5 (peak ≤ 10) | 3 (otherwise)
//     score = min(100, drop × multiplier)
//
// Examples: #1→#15 = 100 (capped), #5→#12 = 35, #20→#35 = 45.

import { prisma } from "@/lib/prisma";

export type SuggestedAction = "refresh_content" | "rebuild" | "internal_links";
export type DecaySeverity = "info" | "warn" | "critical";

export interface RankingPoint {
  checkedAt: Date;
  position: number | null;
}

export interface DecayResult {
  /** 0–100. */
  decayScore: number;
  peakPosition: number | null;
  peakAt: Date | null;
  currentPosition: number | null;
  positionsLost: number | null; // null when dropped out / no peak
  droppedOut: boolean;
  suggestedAction: SuggestedAction;
  severity: DecaySeverity;
}

const NOISE_THRESHOLD = 2; // ≤2 positions of movement is noise
const FINDING_THRESHOLD = 25; // findings are created at score ≥ 25

function severityFor(score: number): DecaySeverity {
  if (score >= 70) return "critical";
  if (score >= 40) return "warn";
  return "info";
}

function actionFor(score: number, drop: number | null, droppedOut: boolean): SuggestedAction {
  if (droppedOut || (drop != null && drop >= 20)) return "rebuild";
  if (drop != null && drop >= 8) return "refresh_content";
  return "internal_links";
}

/** Pure decay computation from a keyword's ranking history (unit-testable). */
export function computeDecay(history: RankingPoint[]): DecayResult {
  const ranked = history.filter((h) => h.position != null && h.position > 0);
  if (ranked.length === 0) {
    return {
      decayScore: 0,
      peakPosition: null,
      peakAt: null,
      currentPosition: history.length ? history[history.length - 1].position : null,
      positionsLost: null,
      droppedOut: false,
      suggestedAction: "internal_links",
      severity: "info",
    };
  }

  // Peak = best (lowest) position ever in the window; earliest wins ties.
  let peak = ranked[0];
  for (const h of ranked) {
    if (h.position! < peak.position! || (h.position === peak.position && h.checkedAt < peak.checkedAt)) {
      peak = h;
    }
  }
  const current = history[history.length - 1];
  const currentPosition = current.position ?? null;
  const droppedOut = currentPosition == null;

  if (droppedOut) {
    const score = peak.position! <= 10 ? 100 : 80;
    return {
      decayScore: score,
      peakPosition: peak.position,
      peakAt: peak.checkedAt,
      currentPosition: null,
      positionsLost: null,
      droppedOut: true,
      suggestedAction: actionFor(score, null, true),
      severity: severityFor(score),
    };
  }

  const drop = currentPosition - peak.position!;
  if (drop <= NOISE_THRESHOLD) {
    return {
      decayScore: 0,
      peakPosition: peak.position,
      peakAt: peak.checkedAt,
      currentPosition,
      positionsLost: Math.max(0, drop),
      droppedOut: false,
      suggestedAction: "internal_links",
      severity: "info",
    };
  }

  const multiplier = peak.position! <= 3 ? 8 : peak.position! <= 10 ? 5 : 3;
  const score = Math.min(100, drop * multiplier);
  return {
    decayScore: score,
    peakPosition: peak.position,
    peakAt: peak.checkedAt,
    currentPosition,
    positionsLost: drop,
    droppedOut: false,
    suggestedAction: actionFor(score, drop, false),
    severity: severityFor(score),
  };
}

export interface DecayDetectionSummary {
  projectsChecked: number;
  findingsCreated: number;
  findingsUpdated: number;
  findingsResolved: number; // recovered on their own
  criticalAlerts: number;
}

interface Emitter {
  (input: {
    workspaceId: string;
    projectId: string;
    trigger: string;
    severity: "info" | "warn" | "critical";
    title: string;
    body: string;
    link: string;
    scopeKeywordIds?: string[];
    dedupKey?: string;
  }): Promise<unknown>;
}

/**
 * Weekly decay detection for one project. Groups tracked keywords by their
 * latest ranking URL (one finding per decaying page), upserts open findings,
 * auto-resolves recovered ones, and emits content_decay alerts for
 * critical findings. Best-effort: alert failures never break detection.
 */
export async function detectDecayForProject(
  project: { id: string; workspaceId: string; domain: string },
  emit: Emitter,
  audit: (action: "decay_finding_created" | "decay_finding_resolved", summary: string) => Promise<void>,
): Promise<Omit<DecayDetectionSummary, "projectsChecked">> {
  const now = new Date();
  const windowStart = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  const dayKey = now.toISOString().slice(0, 10);

  const keywords = await prisma.keyword.findMany({
    where: { projectId: project.id, tracked: true },
    select: { id: true, phrase: true },
  });

  // Group keywords by latest ranking URL (unranked keywords group under a
  // synthetic key so drop-outs still surface).
  interface UrlGroup {
    url: string | null;
    keywordIds: string[];
    phrases: string[];
    histories: Array<{ phrase: string; keywordId: string; history: RankingPoint[] }>;
  }
  const groups = new Map<string, UrlGroup>();

  for (const kw of keywords) {
    const history = await prisma.ranking.findMany({
      where: { keywordId: kw.id, checkedAt: { gte: windowStart } },
      orderBy: { checkedAt: "asc" },
      select: { checkedAt: true, position: true, url: true },
    });
    if (history.length < 2) continue; // need a before/after to detect decay
    const latestUrl = [...history].reverse().find((h) => h.url)?.url ?? null;
    const key = latestUrl ?? `unranked:${kw.id}`;
    let g = groups.get(key);
    if (!g) {
      g = { url: latestUrl, keywordIds: [], phrases: [], histories: [] };
      groups.set(key, g);
    }
    g.keywordIds.push(kw.id);
    g.phrases.push(kw.phrase);
    g.histories.push({
      phrase: kw.phrase,
      keywordId: kw.id,
      history: history.map((h) => ({ checkedAt: h.checkedAt, position: h.position })),
    });
  }

  let findingsCreated = 0;
  let findingsUpdated = 0;
  let findingsResolved = 0;
  let criticalAlerts = 0;

  for (const g of groups.values()) {
    // Page decay = worst keyword decay in the group (the page's headline story).
    let worst: DecayResult | null = null;
    let worstKeywordId: string | null = null;
    for (const h of g.histories) {
      const d = computeDecay(h.history);
      if (!worst || d.decayScore > worst.decayScore) {
        worst = d;
        worstKeywordId = h.keywordId;
      }
    }
    if (!worst) continue;

    const existing = await prisma.contentDecayFinding.findFirst({
      where: { projectId: project.id, url: g.url, status: "open" },
    });

    if (worst.decayScore >= FINDING_THRESHOLD) {
      if (existing) {
        await prisma.contentDecayFinding.update({
          where: { id: existing.id },
          data: {
            decayScore: worst.decayScore,
            peakPosition: worst.peakPosition,
            currentPosition: worst.currentPosition,
            peakAt: worst.peakAt,
            suggestedAction: worst.suggestedAction,
            severity: worst.severity,
            phrases: g.phrases,
            keywordId: worstKeywordId,
          },
        });
        findingsUpdated += 1;
      } else {
        await prisma.contentDecayFinding.create({
          data: {
            projectId: project.id,
            keywordId: worstKeywordId,
            url: g.url,
            phrases: g.phrases,
            decayScore: worst.decayScore,
            peakPosition: worst.peakPosition,
            currentPosition: worst.currentPosition,
            peakAt: worst.peakAt,
            suggestedAction: worst.suggestedAction,
            severity: worst.severity,
            status: "open",
          },
        });
        findingsCreated += 1;
        await audit(
          "decay_finding_created",
          `Decay finding: ${g.url ?? "(unranked page)"} on ${project.domain} (score ${Math.round(worst.decayScore)})`,
        ).catch(() => {});
      }

      if (worst.severity === "critical") {
        const peak = worst.peakPosition != null ? `#${worst.peakPosition}` : "unranked";
        const cur = worst.currentPosition != null ? `#${worst.currentPosition}` : "out of top 100";
        try {
          await emit({
            workspaceId: project.workspaceId,
            projectId: project.id,
            trigger: "content_decay",
            severity: "critical",
            title: `🚨 Content decaying: ${g.url ?? g.phrases[0]} (${peak} → ${cur})`,
            body: `"${g.phrases.slice(0, 3).join('", "')}"${g.phrases.length > 3 ? ` +${g.phrases.length - 3} more` : ""} decayed on ${project.domain}. Suggested action: ${worst.suggestedAction.replace(/_/g, " ")}.`,
            link: `/dashboard/projects/${project.id}/decay`,
            scopeKeywordIds: g.keywordIds,
            dedupKey: `content_decay:${g.url ?? g.keywordIds[0]}:${dayKey}`,
          });
          criticalAlerts += 1;
        } catch {
          // alert failures never break detection
        }
      }
    } else if (existing) {
      // Recovered on its own — close the finding, keep the history.
      await prisma.contentDecayFinding.update({
        where: { id: existing.id },
        data: { status: "actioned", resolvedAt: now, note: "Recovered: rankings returned above the decay threshold." },
      });
      findingsResolved += 1;
      await audit(
        "decay_finding_resolved",
        `Decay finding auto-resolved (recovered): ${g.url ?? "(unranked page)"} on ${project.domain}`,
      ).catch(() => {});
    }
  }

  return { findingsCreated, findingsUpdated, findingsResolved, criticalAlerts };
}
