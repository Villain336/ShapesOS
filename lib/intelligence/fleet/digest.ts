// Marketr — Phase 10 M4: weekly competitor digest.
//
// Aggregates the last 7 days of CompetitorChange rows per watched competitor:
// publishing velocity, pricing/offer changes, keyword/SERP presence (via the
// M6 fetchSerp contract — graceful when unavailable), and review velocity.
//
// Delivered as: (1) this structured object, (2) the UI view at
// /dashboard/intelligence/competitors (Digest tab), (3) a `competitor_radar`
// alert via the milestone-13 hub (existing live trigger — no new sending).
// Email delivery: NOT built — no approval-gated Phase 4/5 email path exists
// for digests (lib/mail is direct-mail campaigns; newsletter sends are
// campaign-scoped), and the task says to check, not build new sending.

import type { TxClient } from "@/lib/substrate/graph/rls";
import type {
  CompetitorDigest,
  DigestCompetitor,
  DigestSerpEntry,
} from "./types";
import { domainOf, fetchSerpTop10, isSerpUnavailable } from "./serp-contract";

export interface DigestInput {
  workspaceId: string;
  weekStart: Date;
  weekEnd: Date;
  changes: Array<{
    watchId: string;
    competitorDomain: string;
    url: string;
    changeType: string;
    semanticSummary: string | null;
    detectedAt: Date;
  }>;
  watches: Array<{ id: string; competitorDomain: string; projectId: string }>;
  keywords: string[];
  /** WatchId → has this watch shipped page changes this week. */
  pageChangeByWatch: Set<string>;
}

const PRICING_OFFER_RE =
  /\b(pric|price|discount|coupon|% off|free trial|plan|\/mo\b|per month)/i;

/** Pure aggregation — unit-tested on fixtures, no DB/network. */
export function aggregateDigest(input: DigestInput): Omit<CompetitorDigest, "serpPresence" | "serpAvailable" | "reviewVelocity"> {
  const byWatch = new Map<string, DigestCompetitor>();
  for (const w of input.watches) {
    byWatch.set(w.id, {
      domain: w.competitorDomain,
      pagesAdded: 0,
      pagesRemoved: 0,
      pagesUpdated: 0,
      pricingOfferChanges: 0,
      topChanges: [],
    });
  }
  const totals = {
    pagesAdded: 0,
    pagesRemoved: 0,
    pagesUpdated: 0,
    pricingOfferChanges: 0,
    changes: 0,
  };

  const sorted = [...input.changes].sort(
    (a, b) => b.detectedAt.getTime() - a.detectedAt.getTime(),
  );
  for (const c of sorted) {
    const bucket = byWatch.get(c.watchId);
    if (!bucket) continue;
    totals.changes++;
    if (c.changeType === "page_added") {
      bucket.pagesAdded++;
      totals.pagesAdded++;
    } else if (c.changeType === "page_removed") {
      bucket.pagesRemoved++;
      totals.pagesRemoved++;
    } else {
      bucket.pagesUpdated++;
      totals.pagesUpdated++;
    }
    const summaryText = `${c.semanticSummary ?? ""} ${c.url}`;
    if (PRICING_OFFER_RE.test(summaryText)) {
      bucket.pricingOfferChanges++;
      totals.pricingOfferChanges++;
    }
    if (bucket.topChanges.length < 5) {
      bucket.topChanges.push({
        url: c.url,
        changeType: c.changeType as DigestCompetitor["topChanges"][number]["changeType"],
        summary: c.semanticSummary,
      });
    }
  }

  return {
    workspaceId: input.workspaceId,
    weekStart: input.weekStart.toISOString(),
    weekEnd: input.weekEnd.toISOString(),
    generatedAt: new Date().toISOString(),
    competitors: [...byWatch.values()].filter(
      (c) => c.pagesAdded + c.pagesRemoved + c.pagesUpdated > 0,
    ),
    totals,
  };
}

/** Full builder: DB reads + SERP presence + review velocity. */
export async function buildWeeklyDigest(
  tx: TxClient,
  workspaceId: string,
  opts: { now?: Date; maxKeywords?: number } = {},
): Promise<CompetitorDigest> {
  const now = opts.now ?? new Date();
  const weekEnd = now;
  const weekStart = new Date(now.getTime() - 7 * 24 * 3600 * 1000);

  const watches = await tx.competitorWatch.findMany({
    where: { workspaceId },
    select: { id: true, competitorDomain: true, projectId: true },
  });
  const watchIds = watches.map((w) => w.id);

  const changes = await tx.competitorChange.findMany({
    where: {
      workspaceId,
      watchId: { in: watchIds },
      detectedAt: { gte: weekStart, lte: weekEnd },
    },
    select: {
      watchId: true,
      url: true,
      changeType: true,
      semanticSummary: true,
      detectedAt: true,
      watch: { select: { competitorDomain: true } },
    },
    orderBy: { detectedAt: "desc" },
    take: 2000,
  });

  const keywords = await tx.keyword.findMany({
    where: { projectId: { in: watches.map((w) => w.projectId) } },
    select: { phrase: true },
    orderBy: { volume: "desc" },
    take: opts.maxKeywords ?? 15,
  });

  const pageChangeByWatch = new Set(
    changes.filter((c) => c.changeType === "page_added").map((c) => c.watchId),
  );

  const base = aggregateDigest({
    workspaceId,
    weekStart,
    weekEnd,
    changes: changes.map((c) => ({
      watchId: c.watchId,
      competitorDomain: c.watch.competitorDomain,
      url: c.url,
      changeType: c.changeType,
      semanticSummary: c.semanticSummary,
      detectedAt: c.detectedAt,
    })),
    watches,
    keywords: keywords.map((k) => k.phrase),
    pageChangeByWatch,
  });

  // SERP presence: which watched competitors sit in the top 10 for tracked
  // keywords this week. Labeled as presence, not gains — v1 keeps no SERP
  // baseline to diff against (documented honestly). Spend routes through
  // M6's circuit breaker inside fetchSerp (routing.ts); VendorNotConfigured
  // degrades to serpAvailable=false instead of failing the digest.
  const serpPresence: DigestSerpEntry[] = [];
  let serpAvailable = true;
  const watchedDomains = new Set(watches.map((w) => w.competitorDomain.toLowerCase()));
  const watchByDomain = new Map(watches.map((w) => [w.competitorDomain.toLowerCase(), w.id]));
  for (const k of keywords.slice(0, 10)) {
    try {
      const results = await fetchSerpTop10(workspaceId, k.phrase, "en-US", { numResults: 10 });
      for (const r of results) {
        const d = (r.domain ?? domainOf(r.url) ?? "").toLowerCase();
        if (d && watchedDomains.has(d)) {
          serpPresence.push({
            keyword: k.phrase,
            competitorDomain: d,
            position: r.position,
            backedByPageChange: pageChangeByWatch.has(watchByDomain.get(d)!),
          });
        }
      }
    } catch (err) {
      if (isSerpUnavailable(err)) {
        serpAvailable = false;
        break; // no vendor configured — skip the rest, don't burn attempts
      }
      // one keyword's SERP failing must not fail the digest
    }
  }

  // Review velocity — licensed adapters only, all graceful when unconfigured.
  // Per-business pulls need an explicit business identity (Yelp business id
  // or name + lat/lng for DataForSEO), so the weekly digest reports adapter
  // availability; the actual pulls run from the UI/API with explicit input.
  const reviewVelocityRows: CompetitorDigest["reviewVelocity"] = [
    {
      source: "yelp",
      status: (process.env.YELP_API_KEY ?? "").trim() ? "ok" : "unconfigured",
      reviewsThisWeek: 0,
      avgRating: null,
      detail: (process.env.YELP_API_KEY ?? "").trim()
        ? "Yelp Fusion configured — run a per-business pull from the competitors UI or API."
        : "YELP_API_KEY not set — Yelp Fusion adapter idle (free tier available).",
    },
    {
      source: "dataforseo",
      status: "unconfigured",
      reviewsThisWeek: 0,
      avgRating: null,
      detail: "Needs a business identity (name + lat/lng) — run from the competitors UI or API with explicit coordinates.",
    },
    {
      source: "gbp",
      status: "unconfigured",
      reviewsThisWeek: 0,
      avgRating: null,
      detail: "GBP API application backlogged; connector is mock-only with no review surface.",
    },
  ];

  return { ...base, serpPresence, serpAvailable, reviewVelocity: reviewVelocityRows };
}
