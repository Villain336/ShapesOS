// Marketr — AI search visibility (milestone 14).
//
// Extends milestone 5's AI Overview presence tracking with per-keyword
// snapshots that also record whether the project's own domain is *cited*
// inside the AI answer, plus aggregate summaries for the dashboard.
//
// Data source: the SEO provider's SerpSnapshot (lib/providers). Citation
// detection is limited to what the provider exposes: the live DataForSEO
// parser pulls `references` from ai_overview SERP items; the mock provider
// exposes none, so mock snapshots never report citations.

import { prisma } from "@/lib/prisma";
import { domainMatches } from "@/lib/rankings";
import type { SerpSnapshot } from "@/lib/providers/types";

export interface CitationInfo {
  siteCited: boolean;
  citedUrl: string | null;
}

/** Does any AI Overview citation belong to the project's domain? */
export function detectCitation(
  snapshot: SerpSnapshot,
  projectDomain: string,
): CitationInfo {
  for (const ref of snapshot.aiOverviewCitations ?? []) {
    if (ref.domain && domainMatches(ref.domain, projectDomain)) {
      return { siteCited: true, citedUrl: ref.url ?? null };
    }
  }
  return { siteCited: false, citedUrl: null };
}

export interface SnapshotChange {
  appeared: boolean; // AI Overview newly present (vs previous snapshot)
  disappeared: boolean; // AI Overview no longer present
  citationGained: boolean; // site newly cited
  citationLost: boolean; // site no longer cited
}

/** Diff the new snapshot against the previous one for alert emission. */
export function snapshotChanges(
  previous: { aiOverviewPresent: boolean; siteCited: boolean } | null,
  current: { aiOverviewPresent: boolean; siteCited: boolean },
): SnapshotChange {
  const prev = previous ?? { aiOverviewPresent: false, siteCited: false };
  return {
    appeared: !prev.aiOverviewPresent && current.aiOverviewPresent,
    disappeared: prev.aiOverviewPresent && !current.aiOverviewPresent,
    citationGained: !prev.siteCited && current.siteCited,
    citationLost: prev.siteCited && !current.siteCited,
  };
}

/**
 * Record one AI visibility snapshot for a keyword check. Returns the stored
 * row plus the diff vs the previous snapshot (for alert emission).
 */
export async function recordSnapshot(input: {
  projectId: string;
  keywordId: string;
  snapshot: SerpSnapshot;
  projectDomain: string;
  checkedAt: Date;
  mock: boolean;
}) {
  const { projectId, keywordId, snapshot, projectDomain, checkedAt, mock } = input;
  const aiOverviewPresent = snapshot.aiOverviewPresent ?? false;
  const { siteCited, citedUrl } = detectCitation(snapshot, projectDomain);

  const previous = await prisma.aIVisibilitySnapshot.findFirst({
    where: { keywordId, checkedAt: { lt: checkedAt } },
    orderBy: { checkedAt: "desc" },
    select: { aiOverviewPresent: true, siteCited: true },
  });

  const row = await prisma.aIVisibilitySnapshot.create({
    data: {
      projectId,
      keywordId,
      checkedAt,
      aiOverviewPresent,
      siteCited,
      citedUrl,
      mock,
    },
  });

  return {
    row,
    changes: snapshotChanges(previous, { aiOverviewPresent, siteCited }),
  };
}

export interface DailyAIPoint {
  date: string; // yyyy-mm-dd
  checked: number;
  overviewPresent: number;
  siteCited: number;
}

export interface AIVisibilitySummary {
  keywordsTracked: number;
  /** % of tracked keywords whose latest snapshot has an AI Overview. */
  presencePct: number;
  /** % of tracked keywords where the site is cited in the AI answer. */
  citationPct: number;
  /** % of keywords with an AI Overview where the site is cited. */
  citationShareOfOverviewsPct: number;
  trend: DailyAIPoint[];
  perKeyword: Array<{
    keywordId: string;
    phrase: string;
    aiOverviewPresent: boolean;
    siteCited: boolean;
    citedUrl: string | null;
    checkedAt: string;
  }>;
}

/** Aggregate the dashboard summary for a project over the last `days` days. */
export async function aiVisibilitySummary(
  projectId: string,
  days = 30,
): Promise<AIVisibilitySummary> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const [keywords, snapshots] = await Promise.all([
    prisma.keyword.findMany({
      where: { projectId, tracked: true },
      select: { id: true, phrase: true },
      orderBy: { phrase: "asc" },
    }),
    prisma.aIVisibilitySnapshot.findMany({
      where: { projectId, checkedAt: { gte: since } },
      orderBy: { checkedAt: "asc" },
      include: { keyword: { select: { phrase: true } } },
    }),
  ]);

  // Latest snapshot per keyword.
  const latest = new Map<string, (typeof snapshots)[number]>();
  for (const s of snapshots) {
    const cur = latest.get(s.keywordId);
    if (!cur || s.checkedAt > cur.checkedAt) latest.set(s.keywordId, s);
  }

  const present = [...latest.values()].filter((s) => s.aiOverviewPresent).length;
  const cited = [...latest.values()].filter((s) => s.siteCited).length;
  const n = keywords.length;
  const pct = (x: number) => (n === 0 ? 0 : Math.round((100 * x) / n));

  // Daily trend buckets.
  const byDay = new Map<string, { checked: Set<string>; present: number; cited: number }>();
  for (const s of snapshots) {
    const day = s.checkedAt.toISOString().slice(0, 10);
    let b = byDay.get(day);
    if (!b) {
      b = { checked: new Set(), present: 0, cited: 0 };
      byDay.set(day, b);
    }
    // Count presence/citation once per keyword per day (latest wins).
    b.checked.add(s.keywordId);
    if (s.aiOverviewPresent) b.present += 1;
    if (s.siteCited) b.cited += 1;
  }
  const trend: DailyAIPoint[] = [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, b]) => ({
      date,
      checked: b.checked.size,
      overviewPresent: b.present,
      siteCited: b.cited,
    }));

  return {
    keywordsTracked: n,
    presencePct: pct(present),
    citationPct: pct(cited),
    citationShareOfOverviewsPct: present === 0 ? 0 : Math.round((100 * cited) / present),
    trend,
    perKeyword: keywords.map((k) => {
      const s = latest.get(k.id);
      return {
        keywordId: k.id,
        phrase: k.phrase,
        aiOverviewPresent: s?.aiOverviewPresent ?? false,
        siteCited: s?.siteCited ?? false,
        citedUrl: s?.citedUrl ?? null,
        checkedAt: s?.checkedAt.toISOString() ?? "",
      };
    }),
  };
}
