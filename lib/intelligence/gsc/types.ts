// Marketr — Phase 10 M1: GSC-first rank intelligence — shared types.
//
// GSC is the default rank truth for owned sites; paid SERP (M6 contract) is
// residual-only: competitor keywords, zero-impression queries, SERP-feature
// composition.

/** Granularity of a GSC snapshot. Hourly = HOURLY_ALL dataState (last ~30d only). */
export type GscGranularity = "hourly" | "daily";

/** One aggregated query × page × country × device row from Search Analytics. */
export interface GscSnapshotRow {
  query: string;
  page: string;
  /** ISO country code, e.g. "USA". Null = all countries. */
  country: string | null;
  /** "DESKTOP" | "MOBILE" | "TABLET" | null (all devices). */
  device: string | null;
  clicks: number;
  impressions: number;
  /** Average CTR as returned by GSC (0–1). */
  ctr: number;
  /** Average position as returned by GSC (>= 1). */
  position: number;
}

/** Closed date window. Half-open semantics: [start, end). */
export interface DateWindow {
  start: Date;
  end: Date;
}

/**
 * The measurement primitive M2's radar consumes.
 *
 * deltaPosition = post.avgPosition − pre.avgPosition, so NEGATIVE = moved up
 * (improved). magnitude = 0–100 blended change score (clicks/impressions/
 * position), normalized against the largest move in the same computeDeltas
 * call so sibling rows are comparable.
 */
export interface PageQueryDelta {
  projectId: string;
  page: string;
  query: string;
  deltaClicks: number;
  deltaImpressions: number;
  deltaPosition: number;
  magnitude: number;
}

/** Winners/losers view over a delta set. */
export interface WinnersLosers {
  winners: PageQueryDelta[];
  losers: PageQueryDelta[];
  /** Count of page×query pairs that improved vs declined. */
  improvedCount: number;
  declinedCount: number;
}

/** One row in the rank table UI, badged by data source. */
export interface RankTableRow extends PageQueryDelta {
  /** "gsc" for owned keywords; "paid" for residual vendor rows. */
  source: "gsc" | "paid";
  /** Avg position in the post window (null when the query has no GSC coverage). */
  postPosition: number | null;
  /** Avg position in the pre window. */
  prePosition: number | null;
}

/** Which rank source a keyword check should resolve through. */
export type CheckSource = "gsc" | "paid_vendor";
