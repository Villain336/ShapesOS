// Marketr — review sentiment classification + theme extraction (milestone 16).
//
// Two-tier design:
//   1. When a live LLM is configured (lib/llm), classify via a single-word
//      prompt — the workspace already pays for that key.
//   2. Otherwise (mock LLM, or LLM failure), fall back to a deterministic
//      heuristic so review monitoring works with zero configuration.
// Theme extraction is always heuristic (token frequency with a stopword
// list) — no LLM cost, fully deterministic, fixture-tested.

import { getLlmProviderFor } from "../llm";

export type Sentiment = "pos" | "neu" | "neg";

const POSITIVE_WORDS = new Set(
  "amazing awesome excellent fantastic great incredible outstanding perfect wonderful love loved best recommend highly professional friendly fast quick clean thorough helpful knowledgeable courteous prompt efficient impressive superb satisfied pleased".split(" "),
);
const NEGATIVE_WORDS = new Set(
  "terrible awful horrible worst hate hated disappointing disappointed bad poor slow rude unprofessional sloppy messy late broken scam ripoff overpriced useless incompetent never avoid horrible".split(" "),
);

const STOPWORDS = new Set(
  ("a,an,the,and,or,but,if,then,else,for,to,of,in,on,at,by,with,from,as,is,was,were,are,be,been,being," +
    "it,its,this,that,these,those,i,me,my,we,our,you,your,he,she,they,them,his,her,their," +
    "not,no,do,does,did,will,would,could,should,can,had,has,have,very,really,just,so,such," +
    "service,services,business,company,work,job,experience,time,place,one,two,also,all,any," +
    "get,got,had,here,there,their,what,when,where,which,who,will,with,would,year,years,day,days"
  ).split(","),
);

/**
 * Deterministic heuristic sentiment. Rating acts as a prior: 1–2 ★ starts
 * negative, 4–5 ★ starts positive, 3 ★ starts neutral; word counts then
 * shift the score. Pure — fixture-tested.
 */
export function heuristicSentiment(
  text: string | null,
  rating: number | null,
): Sentiment {
  let score = 0;
  if (rating != null) {
    if (rating <= 2) score -= 2;
    else if (rating >= 4) score += 2;
  }
  const words = (text ?? "").toLowerCase().split(/[^a-z']+/);
  for (const w of words) {
    if (POSITIVE_WORDS.has(w)) score += 1;
    else if (NEGATIVE_WORDS.has(w)) score -= 1;
  }
  if (score >= 2) return "pos";
  if (score <= -2) return "neg";
  return "neu";
}

/**
 * Classify one review's sentiment. Uses the live LLM when configured,
 * otherwise the heuristic. Never throws — falls back to heuristic on any
 * LLM failure or unparseable output.
 */
export async function classifySentiment(
  text: string | null,
  rating: number | null,
  /** Phase 15: the workspace the review belongs to — its own model key and
   *  token metering. Omitted = platform key, unmetered (tests, scripts). */
  workspaceId?: string,
): Promise<{ sentiment: Sentiment; via: "llm" | "heuristic" }> {
  // Phase D: one-word classification → "bulk" workload.
  const provider = workspaceId
    ? await (await import("@/lib/llm/workspace")).getLlmProviderForWorkspace("bulk", { workspaceId })
    : getLlmProviderFor("bulk");
  if (provider.isLive) {
    try {
      const prompt =
        "Classify the sentiment of this customer review as exactly one word: pos, neu, or neg.\n" +
        `Rating: ${rating ?? "unknown"} stars\n` +
        `Review: ${(text ?? "").slice(0, 1000)}`;
      const out = (await provider.generate(prompt)).trim().toLowerCase();
      const m = out.match(/\b(pos|neu|neg)\b/);
      if (m) return { sentiment: m[1] as Sentiment, via: "llm" };
    } catch {
      // fall through to heuristic
    }
  }
  return { sentiment: heuristicSentiment(text, rating), via: "heuristic" };
}

export interface ThemeCount {
  theme: string;
  count: number;
}

/**
 * Extract top themes from review texts: token frequency minus stopwords and
 * sentiment words, min 3 chars, appearing in at least 2 reviews.
 * Deterministic — fixture-tested.
 */
export function extractThemes(
  texts: Array<string | null>,
  limit = 8,
): ThemeCount[] {
  const docFreq = new Map<string, number>();
  for (const t of texts) {
    if (!t) continue;
    const seen = new Set<string>();
    for (const w of t.toLowerCase().split(/[^a-z']+/)) {
      if (w.length < 3 || STOPWORDS.has(w)) continue;
      seen.add(w);
    }
    for (const w of seen) docFreq.set(w, (docFreq.get(w) ?? 0) + 1);
  }
  return [...docFreq.entries()]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([theme, count]) => ({ theme, count }));
}

/** Severity routing for review alerts: 1★ critical, 2★ warn. */
export function reviewSeverity(rating: number | null): "critical" | "warn" | "info" {
  if (rating === 1) return "critical";
  if (rating === 2) return "warn";
  return "info";
}
