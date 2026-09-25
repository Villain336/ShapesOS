// Marketr — A1 AEO: per-engine scoring.
// §9.9: NO composite AI-visibility scores — 89% cross-engine citation
// divergence makes them un-actionable. Every metric below is computed per
// engine and there is intentionally no function that blends engines.

import { isRecommended, type Sentiment } from "./judge";
import type { AeoEngineName } from "./engines";

export interface ScorableMention {
  promptIdx: number;
  rep: number;
  mentioned: boolean;
  position: number | null;
  sentiment: Sentiment | null;
  competitors: string[];
  citedSources: string[];
  responseText?: string | null;
}

export interface SentimentDistribution {
  positive: number;
  neutral: number;
  negative: number;
  unmentioned: number;
}

export interface PerEngineScore {
  engine: AeoEngineName;
  responses: number;
  prompts: number;
  /** Mean % of reps per prompt where the brand was mentioned (the Lumora pattern). */
  mentionRate: number;
  /** (brand appearances ÷ total responses) × 100 */
  answerShareOfVoice: number;
  /** % of responses where the brand is the recommended pick. */
  recommendationRate: number;
  sentiment: SentimentDistribution;
  /**
   * % of mentioned responses where the canonical brand string appears verbatim.
   * Null when response text was not recorded for the mentions (can't verify).
   */
  entityAccuracy: number | null;
  /** Cited-source frequency by domain. */
  citationFrequencyByDomain: Record<string, number>;
}

function pct(n: number, d: number): number {
  return d === 0 ? 0 : (n / d) * 100;
}

/** Score ONE engine's mentions. Never call this across engines and average — that's a composite. */
export function scoreEngine(
  engine: AeoEngineName,
  mentions: ScorableMention[],
  brand: string,
): PerEngineScore {
  const brandLower = brand.toLowerCase();
  const promptIdxs = new Set(mentions.map((m) => m.promptIdx));
  const responses = mentions.length;
  const prompts = promptIdxs.size;

  let mentionRateSum = 0;
  for (const idx of promptIdxs) {
    const reps = mentions.filter((m) => m.promptIdx === idx);
    mentionRateSum += pct(reps.filter((m) => m.mentioned).length, reps.length);
  }
  const mentionRate = prompts === 0 ? 0 : mentionRateSum / prompts;

  const appearances = mentions.filter((m) => m.mentioned).length;
  const answerShareOfVoice = pct(appearances, responses);

  const recommended = mentions.filter((m) =>
    isRecommended(m.mentioned, m.position, m.sentiment),
  ).length;
  const recommendationRate = pct(recommended, responses);

  const sentiment: SentimentDistribution = { positive: 0, neutral: 0, negative: 0, unmentioned: 0 };
  for (const m of mentions) {
    if (!m.mentioned) sentiment.unmentioned += 1;
    else if (m.sentiment === "positive") sentiment.positive += 1;
    else if (m.sentiment === "negative") sentiment.negative += 1;
    else sentiment.neutral += 1;
  }

  const mentioned = mentions.filter((m) => m.mentioned);
  const withText = mentioned.filter((m) => (m.responseText ?? "").length > 0);
  const verbatim = withText.filter((m) =>
    (m.responseText ?? "").toLowerCase().includes(brandLower),
  ).length;
  // Entity accuracy is only meaningful when response text was recorded.
  const entityAccuracy = brand && withText.length > 0 ? pct(verbatim, withText.length) : null;

  const citationFrequencyByDomain: Record<string, number> = {};
  for (const m of mentions) {
    for (const src of m.citedSources ?? []) {
      const domain = domainOf(src);
      if (!domain) continue;
      citationFrequencyByDomain[domain] = (citationFrequencyByDomain[domain] ?? 0) + 1;
    }
  }

  return {
    engine,
    responses,
    prompts,
    mentionRate,
    answerShareOfVoice,
    recommendationRate,
    sentiment,
    entityAccuracy,
    citationFrequencyByDomain,
  };
}

/**
 * Score a run group per engine. The input maps engine → its mentions.
 * Returns per-engine scores keyed by engine — never a single blended number.
 */
export function scorePerEngine(
  byEngine: Partial<Record<AeoEngineName, ScorableMention[]>>,
  brand: string,
): Record<AeoEngineName, PerEngineScore | null> {
  const engines: AeoEngineName[] = ["openai", "anthropic", "gemini", "perplexity"];
  const out = {} as Record<AeoEngineName, PerEngineScore | null>;
  for (const engine of engines) {
    const mentions = byEngine[engine];
    out[engine] = mentions && mentions.length > 0 ? scoreEngine(engine, mentions, brand) : null;
  }
  return out;
}

export function domainOf(source: string): string | null {
  const s = source.trim().toLowerCase();
  if (!s) return null;
  try {
    const withProto = s.startsWith("http") ? s : `https://${s}`;
    const host = new URL(withProto).hostname.replace(/^www\./, "");
    return host || null;
  } catch {
    const bare = s.replace(/^www\./, "").split(/[\s/]/)[0];
    return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(bare) ? bare : null;
  }
}

/** Round a per-engine score for display. Keeps engines separate. */
export function roundScore(s: PerEngineScore): PerEngineScore {
  const r = (n: number) => Math.round(n * 10) / 10;
  const nr = (n: number | null) => (n === null ? null : r(n));
  return {
    ...s,
    mentionRate: r(s.mentionRate),
    answerShareOfVoice: r(s.answerShareOfVoice),
    recommendationRate: r(s.recommendationRate),
    entityAccuracy: nr(s.entityAccuracy),
  };
}
