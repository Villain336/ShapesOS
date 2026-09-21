// Marketr — rank-tracking logic (milestone 5).
// Pure helpers shared by the check API route and the dashboard:
// domain matching, the unified visibility score, and movement alerts.

/** "https://www.Example.com/blog/" → "example.com". */
export function normalizeDomain(raw: string): string {
  let d = raw.trim().toLowerCase();
  d = d.replace(/^https?:\/\//, "").replace(/^www\./, "");
  d = d.split("/")[0].split("?")[0].split(":")[0];
  return d;
}

/**
 * True when a SERP result domain belongs to the project's domain.
 * Matches the apex domain and any subdomain (blog.example.com → example.com).
 */
export function domainMatches(resultDomain: string, projectDomain: string): boolean {
  const r = normalizeDomain(resultDomain);
  const p = normalizeDomain(projectDomain);
  if (!r || !p) return false;
  return r === p || r.endsWith(`.${p}`);
}

export interface ScoredKeyword {
  volume: number | null;
  /** Latest known position, null = not ranking in the checked depth. */
  position: number | null;
}

/**
 * Unified visibility score, 0–100.
 *
 * Formula: for each tracked keyword with a known position p and monthly
 * volume v, contribution = v × (1 / log2(p + 1)). The 1/log2(p+1) curve
 * models real click-share decay: position 1 keeps 100% of the keyword's
 * weight, position 10 keeps ~29%, position 100 keeps ~15%. Keywords with
 * no known volume count as v = 1; unranked keywords contribute 0.
 * The score is the volume-weighted mean, scaled to 0–100:
 *
 *   score = 100 × Σ(vᵢ / log2(pᵢ + 1)) / Σ(vᵢ)
 *
 * A score of 100 means every tracked keyword ranks #1; 0 means nothing
 * tracked is ranking.
 */
export function visibilityScore(keywords: ScoredKeyword[]): number {
  let weighted = 0;
  let totalWeight = 0;
  for (const k of keywords) {
    const v = k.volume && k.volume > 0 ? k.volume : 1;
    totalWeight += v;
    if (k.position != null && k.position > 0) {
      weighted += v * (1 / Math.log2(k.position + 1));
    }
  }
  if (totalWeight === 0) return 0;
  return Math.round((100 * weighted) / totalWeight);
}

export type AlertKind =
  | "entered_top_10"
  | "left_top_10"
  | "big_gain"
  | "big_loss"
  | "newly_ranking"
  | "dropped_out";

export interface RankAlert {
  keywordId: string;
  phrase: string;
  kind: AlertKind;
  /** Position before the check, null = not ranking. */
  from: number | null;
  /** Position after the check, null = not ranking. */
  to: number | null;
  checkedAt: string;
}

const TOP_10 = 10;
const BIG_MOVE = 5;

/**
 * Movement alerts from the two most recent checks for a keyword.
 * Thresholds: ±5 positions is a "big" move; crossing the top-10 boundary
 * matters on its own. null positions mean "not in the checked depth".
 */
export function computeAlerts(
  keywordId: string,
  phrase: string,
  previous: number | null,
  current: number | null,
  checkedAt: Date,
): RankAlert[] {
  const alerts: RankAlert[] = [];
  const at = checkedAt.toISOString();
  if (previous == null && current != null) {
    alerts.push({ keywordId, phrase, kind: "newly_ranking", from: previous, to: current, checkedAt: at });
    if (current <= TOP_10) {
      alerts.push({ keywordId, phrase, kind: "entered_top_10", from: previous, to: current, checkedAt: at });
    }
    return alerts;
  }
  if (previous != null && current == null) {
    alerts.push({ keywordId, phrase, kind: "dropped_out", from: previous, to: current, checkedAt: at });
    if (previous <= TOP_10) {
      alerts.push({ keywordId, phrase, kind: "left_top_10", from: previous, to: current, checkedAt: at });
    }
    return alerts;
  }
  if (previous != null && current != null) {
    const delta = previous - current; // positive = moved up
    if (previous > TOP_10 && current <= TOP_10) {
      alerts.push({ keywordId, phrase, kind: "entered_top_10", from: previous, to: current, checkedAt: at });
    } else if (previous <= TOP_10 && current > TOP_10) {
      alerts.push({ keywordId, phrase, kind: "left_top_10", from: previous, to: current, checkedAt: at });
    }
    if (delta >= BIG_MOVE) {
      alerts.push({ keywordId, phrase, kind: "big_gain", from: previous, to: current, checkedAt: at });
    } else if (delta <= -BIG_MOVE) {
      alerts.push({ keywordId, phrase, kind: "big_loss", from: previous, to: current, checkedAt: at });
    }
  }
  return alerts;
}
