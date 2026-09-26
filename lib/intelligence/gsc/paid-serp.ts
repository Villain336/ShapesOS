// Marketr — Phase 10 M1: paid-SERP residual layer.
//
// GSC-first rule (SPEC-PHASE10 §M1): paid SERP checks run ONLY for what GSC
// cannot see —
//   1. competitor keywords (GSC only reports your own property),
//   2. zero-impression queries (GSC has no row for them), and
//   3. SERP-feature composition (AIO presence, feature crowding — the M5 input).
//
// Owned keywords ALWAYS resolve from GSC snapshots and never call fetchSerp.
// The paid path goes through the real M6 barrel
// (import { fetchSerp } from "@/lib/intelligence/providers"), whose
// implementation calls assertBudgetAvailable() inside fetchSerp — every paid
// call is circuit-broken by construction, so this module adds no second
// budget gate.

import {
  fetchSerp as contractFetchSerp,
  type SerpResponse,
} from "@/lib/intelligence/providers";
import type { CheckSource, RankTableRow } from "./types";

export type FetchSerpFn = typeof contractFetchSerp;

export interface ResidualDeps {
  /** Test seam: override the M6 fetchSerp (defaults to the barrel import). */
  fetchSerpImpl?: FetchSerpFn;
}

/** A keyword Marketr wants a rank for, with its classification inputs. */
export interface RankCheckKeyword {
  phrase: string;
  locale: string;
  /** True when this keyword belongs to a competitor's tracked set. */
  isCompetitorKeyword: boolean;
  /** True when GSC shows zero impressions for this query (or no row at all). */
  zeroImpressions: boolean;
  /** True when the caller needs SERP-feature composition (AIO, features). */
  needSerpFeatures: boolean;
  /** GSC-sourced position for owned keywords, null when unknown. */
  gscPosition: number | null;
}

/**
 * Classify which source serves a keyword check. Owned keywords → "gsc",
 * always. Residual cases → "paid_vendor".
 */
export function classifyCheckSource(kw: RankCheckKeyword): CheckSource {
  if (kw.isCompetitorKeyword || kw.zeroImpressions || kw.needSerpFeatures) return "paid_vendor";
  return "gsc";
}

/**
 * Resolve rank rows for a batch of keywords. Owned keywords are answered
 * from GSC (no fetchSerp call, ever); residual keywords go through the M6
 * fetchSerp contract. Every returned row is badged by source for the UI.
 */
export async function resolveRankChecks(
  workspaceId: string,
  keywords: RankCheckKeyword[],
  deps: ResidualDeps = {},
): Promise<RankTableRow[]> {
  const fetchSerp = deps.fetchSerpImpl ?? contractFetchSerp;
  const rows: RankTableRow[] = [];

  for (const kw of keywords) {
    const source = classifyCheckSource(kw);
    if (source === "gsc") {
      rows.push({
        projectId: "",
        page: "",
        query: kw.phrase,
        deltaClicks: 0,
        deltaImpressions: 0,
        deltaPosition: 0,
        magnitude: 0,
        source: "gsc",
        postPosition: kw.gscPosition,
        prePosition: null,
      });
      continue;
    }
    // Residual only: competitor keywords, zero-impression queries,
    // SERP-feature composition. Budget-gated inside fetchSerp (M6).
    const serp: SerpResponse = await fetchSerp(workspaceId, kw.phrase, kw.locale, {
      needAiOverview: kw.needSerpFeatures,
    });
    const own = serp.results[0] ?? null;
    rows.push({
      projectId: "",
      page: own?.url ?? "",
      query: kw.phrase,
      deltaClicks: 0,
      deltaImpressions: 0,
      deltaPosition: 0,
      magnitude: 0,
      source: "paid",
      postPosition: own ? own.position : null,
      prePosition: null,
    });
  }
  return rows;
}

/** Convenience: did this check batch spend any paid calls? */
export function paidCallCount(rows: RankTableRow[]): number {
  return rows.filter((r) => r.source === "paid").length;
}
