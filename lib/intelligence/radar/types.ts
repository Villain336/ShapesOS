// Marketr — Phase 10 M2: Platform-change radar — shared types.
//
// Official sources ONLY (SPEC-PHASE10.md §M2 + §2): Google Search Status
// Dashboard (incidents.json), Google Search Central documentation changelog
// RSS, Bing Webmaster blog RSS. No SEO-Twitter/blog scraping — ever.
//
// Event taxonomy (the flagship invariant):
//   rollout    — a confirmed ranking change (e.g. "August 2026 spam update").
//                The ONLY type the correlation engine and alerts act on.
//   docs_change— a documentation edit. NEVER alerted on, NEVER correlated.
//   volatility — third-party flux signal (MozCast etc.); corroboration context
//                only, never the impact source.

import type { PageQueryDelta } from "../gsc/types";
export type { PageQueryDelta };

export type RadarSource = "status_dashboard" | "search_central" | "bing_blog";
export type PlatformEventType = "rollout" | "docs_change" | "volatility";

export const RADAR_SOURCES: Record<RadarSource, { label: string; homeUrl: string }> = {
  status_dashboard: {
    label: "Google Search Status Dashboard",
    homeUrl: "https://status.search.google.com/",
  },
  search_central: {
    label: "Search Central docs changelog",
    homeUrl: "https://developers.google.com/search/updates",
  },
  bing_blog: {
    label: "Bing Webmaster blog",
    homeUrl: "https://blogs.bing.com/webmaster",
  },
};

export const EVENT_TYPE_LABELS: Record<PlatformEventType, string> = {
  rollout: "Rollout",
  docs_change: "Docs change",
  volatility: "Volatility signal",
};

/** One normalized item from an official source, pre-classification. */
export interface RawSourceItem {
  /** Opaque id inside the source (incident id / RSS guid). */
  externalId: string;
  source: RadarSource;
  title: string;
  /** Plain-text summary (HTML stripped). */
  summary: string;
  startedAt: Date | null;
  endedAt: Date | null;
  url: string | null;
}

/** The classifier's verdict on one raw item. */
export interface ClassifiedEvent {
  eventType: PlatformEventType;
  /** 0..1 — merged heuristic + LLM verdict. */
  confidence: number;
  /** Human-readable reasons, newest evidence first. */
  reasons: string[];
  /** Pure-heuristic score before any LLM pass (0..1). */
  heuristicScore: number;
  /** True when the LLM pass ran and agreed/changed the verdict. */
  llmUsed: boolean;
}

/** A classified raw item, ready to persist. */
export interface PreparedEvent extends RawSourceItem {
  classification: ClassifiedEvent;
}

/** Half-open date window. */
export interface DateWindow {
  start: Date;
  end: Date;
}

/** One page×query row the correlation engine claims as update-impacted. */
export interface CorrelatedImpact {
  projectId: string;
  page: string;
  query: string;
  deltaClicks: number;
  deltaImpressions: number;
  deltaPosition: number;
  /** 0..1 normalized impact strength. */
  impactScore: number;
  /** Honest band [lower, upper] around impactScore — never a point score. */
  confidenceBand: [number, number];
  /** "declined" | "improved" | "mixed" — delta-shaped, per M1's sign convention. */
  direction: "declined" | "improved" | "mixed";
}

/** The baseline-noise machinery behind "only claim what beats the band". */
export interface NoiseBand {
  /** Median of |magnitude| across the delta set. */
  median: number;
  /** Scaled MAD of |magnitude|. */
  mad: number;
  /** Flag threshold = median + 2×MAD. Deltas below this are noise. */
  threshold: number;
  deltasConsidered: number;
}

/** Structured alert object (rendered by the UI; also emitted via the hub). */
export interface RadarAlert {
  platformEventId: string;
  eventTitle: string;
  eventStartedAt: string | null;
  /** "Google's August 18 Spam Update hit 3 of your pages." */
  headline: string;
  affectedProjects: Array<{
    projectId: string;
    domain: string;
    impactedPages: Array<{
      page: string;
      impactScore: number;
      confidenceBand: [number, number];
      direction: CorrelatedImpact["direction"];
      movedQueries: Array<{
        query: string;
        deltaClicks: number;
        deltaImpressions: number;
        deltaPosition: number;
      }>;
    }>;
  }>;
  /** Verification steps — never auto-fix prescriptions. */
  checklist: string[];
}

/** Read-only volatility corroboration (display only). */
export interface VolatilityReading {
  provider: "mozcast" | "semrush_sensor";
  label: string;
  available: boolean;
  /** Provider-native value when available. */
  value: number | null;
  valueLabel: string | null;
  /** Heuristic qualitative band — labeled as such. */
  interpretation: string | null;
  observedAt: string | null;
  detailUrl: string;
}

/** One daily cron sweep's ledger. */
export interface RadarRunResult {
  startedAt: string;
  finishedAt: string;
  workspaceId: string;
  ingested: { created: number; updated: number; skipped: number };
  classified: { rollout: number; docs_change: number; volatility: number };
  correlatedEvents: number;
  impactsWritten: number;
  alertsEmitted: number;
  memoryWrites: number;
  memorySkipped: string | null;
  volatility: VolatilityReading[];
  errors: string[];
}
