// Marketr — Phase 10 M8: opportunity ranking.
//
// Pure function: scored threads ranked by relevance to the workspace.
// Signals:
//   competitor_mention — a tracked competitor domain/name appears in the
//                        thread (their customers complaining = your opening)
//   expertise_match    — thread text matches the workspace's tracked keyword
//                        phrases (Phase 1 storage — "a question matches the
//                        user's expertise")
//   launch_moment      — Show HN / "just launched" / feedback-seeking
//                        threads (high-attention windows worth joining)
//
// Scoring is deliberately simple and inspectable: weights + recency decay.
// relevanceReason is the human-readable "why" shown in the queue UI.

import type { ExpertiseProfile, OpportunitySignal, RawThread, ScoredOpportunity } from "./types";

const COMPETITOR_HIT = 50;
const EXPERTISE_HIT = 12;
const EXPERTISE_CAP = 48;
const LAUNCH_HIT = 30;
const RECENCY_DECAY_PER_DAY = 1.5;

const LAUNCH_PATTERNS = [
  /show\s+hn/i,
  /just\s+launch/i,
  /we'?re?\s+launching/i,
  /launching\s+(today|this\s+week|soon)/i,
  /looking\s+for\s+(feedback|beta\s*(testers|users)|early\s+users)/i,
  /seeking\s+feedback/i,
  /announcing/i,
];

/** Bare brand name from a domain: "acme.com" → "acme". */
function brandOf(domain: string): string {
  const host = domain.replace(/^https?:\/\//, "").split("/")[0];
  const parts = host.split(".");
  if (parts.length <= 2) return parts[0];
  // strip common public suffixes one level (co.uk, com.au…)
  const tlds = new Set(["co", "com", "org", "net", "io", "ai"]);
  const lastTwo = parts.slice(-2).join(".");
  if (tlds.has(parts[parts.length - 2]) && parts.length > 2) return parts[parts.length - 3];
  return parts[parts.length - 2] ?? host;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Word-boundary match for short phrases, substring for long ones. */
function phraseHits(haystack: string, phrase: string): boolean {
  const p = phrase.trim();
  if (!p) return false;
  if (p.length <= 4) {
    return new RegExp(`\\b${escapeRegExp(p)}\\b`, "i").test(haystack);
  }
  return haystack.toLowerCase().includes(p.toLowerCase());
}

function ageDays(createdAt: Date, now: Date): number {
  const ms = now.getTime() - createdAt.getTime();
  return Math.max(0, ms / 86_400_000);
}

/**
 * Score + rank threads against the expertise profile. Returns only threads
 * with at least one signal and a positive score, highest first.
 */
export function rankOpportunities(
  threads: RawThread[],
  profile: ExpertiseProfile,
  now: Date = new Date(),
): ScoredOpportunity[] {
  const ownDomains = new Set(profile.projectDomains);
  const scored: ScoredOpportunity[] = [];

  for (const t of threads) {
    const haystack = `${t.title}\n${t.text}`;
    const signals: OpportunitySignal[] = [];
    const matchedKeywords: string[] = [];
    const reasonParts: string[] = [];
    let score = 0;

    // 1. Competitor mention (skip the workspace's own domains).
    const competitorHits: string[] = [];
    for (const domain of profile.competitorDomains) {
      if (ownDomains.has(domain)) continue;
      const brand = brandOf(domain);
      if (
        phraseHits(haystack, domain) ||
        (brand.length > 3 && phraseHits(haystack, brand))
      ) {
        competitorHits.push(domain);
      }
    }
    if (competitorHits.length > 0) {
      signals.push("competitor_mention");
      score += COMPETITOR_HIT;
      reasonParts.push(`competitor mentioned: ${competitorHits.slice(0, 3).join(", ")}`);
    }

    // 2. Expertise match against tracked keyword phrases.
    let expertiseScore = 0;
    for (const kw of profile.trackedKeywords) {
      if (phraseHits(haystack, kw)) {
        matchedKeywords.push(kw);
        expertiseScore += EXPERTISE_HIT;
      }
    }
    if (matchedKeywords.length > 0) {
      signals.push("expertise_match");
      score += Math.min(expertiseScore, EXPERTISE_CAP);
      reasonParts.push(
        `matches your expertise: ${matchedKeywords.slice(0, 4).join(", ")}${matchedKeywords.length > 4 ? ` (+${matchedKeywords.length - 4} more)` : ""}`,
      );
    }

    // 3. Launch moment.
    if (LAUNCH_PATTERNS.some((re) => re.test(haystack))) {
      signals.push("launch_moment");
      score += LAUNCH_HIT;
      reasonParts.push("launch moment — high-attention thread");
    }

    if (signals.length === 0) continue;

    // Recency decay + HN/Reddit points nudge.
    score -= ageDays(t.createdAt, now) * RECENCY_DECAY_PER_DAY;
    if (typeof t.points === "number" && t.points > 0) {
      score += Math.min(t.points, 100) / 20;
    }
    if (score <= 0) continue;

    scored.push({
      ...t,
      score: Math.round(score * 10) / 10,
      signals,
      matchedKeywords,
      relevanceReason: reasonParts.join("; "),
    });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/** Dedupe threads across sources by canonical URL. */
export function dedupeThreads(threads: RawThread[]): RawThread[] {
  const seen = new Set<string>();
  const out: RawThread[] = [];
  for (const t of threads) {
    const key = t.url.replace(/[#?].*$/, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}
