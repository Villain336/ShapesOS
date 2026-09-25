// Marketr — O2 digital PR: expertise matching (pure).
// Scores an opportunity against a client expertise profile → 0–100.
// Matching is keyword + expertise-tag based against the profile (from the
// Business Graph / onboarding inputs). The score feeds deadline triage;
// it never triggers a send on its own.

import type { IngestedOpportunity } from "./ingest";

export interface ExpertiseProfile {
  /** Canonical expertise keywords, e.g. ["cybersecurity", "ai-agents"]. */
  keywords: string[];
  /** Beats the client can credibly speak to, e.g. ["security", "martech"]. */
  beats: string[];
  /** Industries served, e.g. ["small-business", "saas"]. */
  industries: string[];
  /** Outlet tiers the client targets; unknown outlets are neutral. */
  targetOutlets?: string[];
}

/** The default profile used when onboarding has not supplied one yet. */
export const DEFAULT_EXPERTISE_PROFILE: ExpertiseProfile = {
  keywords: ["marketing", "seo", "ai", "growth", "agencies"],
  beats: ["marketing", "technology"],
  industries: ["small-business", "agencies", "saas"],
};

function norm(s: string): string {
  return s.toLowerCase().trim();
}

/** Tokenize text into word tokens (min 3 chars, stop-word filtered). */
function tokens(text: string): Set<string> {
  const stop = new Set([
    "the", "and", "for", "are", "with", "how", "what", "you", "your", "this",
    "that", "from", "have", "has", "was", "were", "seeking", "looking", "need",
    "needed", "want", "comment", "experts", "sources", "request", "single",
  ]);
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 3 && !stop.has(t)),
  );
}

export interface MatchDetail {
  score: number;
  tagHits: string[];
  keywordHits: string[];
  beatHits: string[];
  outletBonus: number;
  reasons: string[];
}

/**
 * Score 0–100: expertise-tag overlap (40), profile-keyword hits in the query
 * (35), beat/industry overlap (15), target-outlet bonus (10). Fail closed:
 * a query that matches nothing scores 0 and is never auto-triaged as a fit.
 */
export function matchOpportunity(
  opportunity: Pick<IngestedOpportunity, "queryText" | "expertiseTags" | "outlet">,
  profile: ExpertiseProfile,
): MatchDetail {
  const reasons: string[] = [];
  let score = 0;

  const profileTerms = new Set([
    ...profile.keywords.map(norm),
    ...profile.beats.map(norm),
    ...profile.industries.map(norm),
  ]);

  const tagHits = opportunity.expertiseTags.filter((t) => profileTerms.has(norm(t)));
  const tagScore = Math.min(40, tagHits.length * 20);
  score += tagScore;
  if (tagHits.length > 0) reasons.push(`expertise tags match: ${tagHits.join(", ")}`);

  const queryTokens = tokens(opportunity.queryText);
  const keywordHits = [...profile.keywords]
    .map(norm)
    .filter((k) => {
      const parts = k.split(/[-\s_]+/);
      return parts.some((p) => queryTokens.has(p));
    });
  const keywordScore = Math.min(35, keywordHits.length * 12);
  score += keywordScore;
  if (keywordHits.length > 0) reasons.push(`query keywords match: ${keywordHits.join(", ")}`);

  const beatHits = [...profile.beats, ...profile.industries]
    .map(norm)
    .filter((b) => queryTokens.has(b) || b.split(/[-\s_]+/).some((p) => queryTokens.has(p)));
  const beatScore = Math.min(15, beatHits.length * 8);
  score += beatScore;
  if (beatHits.length > 0) reasons.push(`beat/industry match: ${beatHits.join(", ")}`);

  let outletBonus = 0;
  if (profile.targetOutlets?.some((o) => norm(o) === norm(opportunity.outlet))) {
    outletBonus = 10;
    reasons.push(`target outlet: ${opportunity.outlet}`);
  }
  score += outletBonus;

  if (reasons.length === 0) reasons.push("no expertise overlap — low priority");

  return {
    score: Math.min(100, Math.max(0, Math.round(score))),
    tagHits,
    keywordHits,
    beatHits,
    outletBonus,
    reasons,
  };
}

export const MATCHED_SCORE_THRESHOLD = 40;

/** True when the opportunity is a strong enough fit to enter the draft pipeline. */
export function isStrongMatch(detail: MatchDetail): boolean {
  return detail.score >= MATCHED_SCORE_THRESHOLD;
}
