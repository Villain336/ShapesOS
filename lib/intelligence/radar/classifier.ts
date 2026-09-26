// Marketr — Phase 10 M2: event classifier.
//
// The critical piece. Each official-source item is labeled:
//   rollout     — confirmed ranking change (correlate + alert)
//   docs_change — documentation edit (NEVER alert, NEVER correlate)
//   volatility  — third-party flux signal (corroboration context only)
//
// Architecture: fast deterministic heuristics first; an LLM pass (cheap
// background workload via the lib/llm router) only fires when heuristic
// confidence is below the LLM floor — keeping the daily run ~$0. The LLM can
// never invent a rollout: it only re-scores the three official classes, and
// when the LLM is unavailable the heuristic verdict stands.
//
// The failure mode is false positives on docs→rollout (e.g. "Search Central
// updated the spam-updates documentation" is docs_change, NOT a rollout).

import { getLlmProviderFor } from "@/lib/llm";
import type { ClassifiedEvent, PlatformEventType, RawSourceItem } from "./types";

export const CLASSIFIER_VERSION = "m2-classifier/1";
/** Below this heuristic confidence, spend one cheap LLM call to re-score. */
export const LLM_REVIEW_FLOOR = 0.8;

const ROLLOUT_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\b(core|spam|helpful content|reviews?)\s+update\b/i, reason: "names a Google update family (core/spam/helpful-content/reviews)" },
  { re: /\brollout\b/i, reason: "rollout language (began / complete / may take)" },
  { re: /\b(released|release[ds]?)\s+the\s+.*update\b/i, reason: "release-of-an-update language" },
  { re: /\balgorithm\s+update\b/i, reason: "explicit 'algorithm update'" },
  { re: /\branking\s+(is\s+)?experiencing\b/i, reason: "dashboard incident affecting ranking" },
  { re: /\baffecting\s+ranking\b/i, reason: "dashboard 'affecting ranking' incident" },
  { re: /\bdiscover\s+(core\s+)?update\b/i, reason: "Discover update" },
];

const DOCS_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\bdocumentation\b/i, reason: "mentions documentation" },
  { re: /\bdocs?\s+(update|change|edit)\b/i, reason: "docs-update language" },
  { re: /\bchangelog\b/i, reason: "changelog entry" },
  { re: /\bstructured\s+data\s+documentation\b/i, reason: "structured-data docs edit" },
  { re: /\b(added|updated|clarified|polished)\s+.*\b(documentation|guide|property)\b/i, reason: "docs-edit phrasing (added/updated/clarified + documentation/guide/property)" },
  { re: /\bnew\s+guide\b/i, reason: "new documentation guide" },
];

const VOLATILITY_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\bvolatility\b/i, reason: "volatility language" },
  { re: /\bunconfirmed\b/i, reason: "explicitly unconfirmed" },
  { re: /\bflux\b/i, reason: "flux language" },
  { re: /\b(sensor|mozcast)\b/i, reason: "references a volatility tracker" },
];

interface HeuristicResult {
  eventType: PlatformEventType;
  score: number;
  reasons: string[];
}

/**
 * Deterministic heuristic pass. Pure function — the unit-test surface.
 *
 * Source priors are strong: the Search Central docs changelog can ONLY ever
 * be docs_change (it is a documentation changelog, by definition), and the
 * Search Status Dashboard only posts confirmed ranking incidents.
 */
export function heuristicClassify(item: RawSourceItem): HeuristicResult {
  const text = `${item.title} ${item.summary}`;
  const reasons: string[] = [];

  // Source priors — the strongest signal, and the spec's boundary made code.
  if (item.source === "search_central") {
    reasons.push("source = Search Central docs changelog (documentation edits by definition)");
    return { eventType: "docs_change", score: 0.97, reasons };
  }
  if (item.source === "status_dashboard") {
    const rolloutHit = ROLLOUT_PATTERNS.find((p) => p.re.test(text));
    reasons.push("source = Search Status Dashboard (confirmed ranking incidents only)");
    if (rolloutHit) {
      reasons.unshift(rolloutHit.reason);
      return { eventType: "rollout", score: 0.95, reasons };
    }
    // Dashboard incident without update naming → still a confirmed ranking
    // incident (e.g. "Ranking is experiencing an ongoing issue"), but weaker.
    return { eventType: "rollout", score: 0.82, reasons };
  }

  // Bing Webmaster blog: mixed content — weigh pattern evidence.
  let rollout = 0;
  let docs = 0;
  let vol = 0;
  for (const p of ROLLOUT_PATTERNS) {
    if (p.re.test(text)) {
      rollout += 1;
      reasons.push(`rollout signal: ${p.reason}`);
    }
  }
  for (const p of DOCS_PATTERNS) {
    if (p.re.test(text)) {
      docs += 1;
      reasons.push(`docs signal: ${p.reason}`);
    }
  }
  for (const p of VOLATILITY_PATTERNS) {
    if (p.re.test(text)) {
      vol += 1;
      reasons.push(`volatility signal: ${p.reason}`);
    }
  }
  if (vol > 0 && rollout === 0) {
    return { eventType: "volatility", score: Math.min(0.9, 0.6 + vol * 0.15), reasons };
  }
  if (rollout > 0 && docs === 0) {
    return { eventType: "rollout", score: Math.min(0.88, 0.55 + rollout * 0.15), reasons };
  }
  if (docs > 0 && rollout === 0) {
    return { eventType: "docs_change", score: Math.min(0.88, 0.55 + docs * 0.15), reasons };
  }
  if (rollout > 0 && docs > 0) {
    // Mixed signals (e.g. "updated the spam-updates documentation") —
    // ambiguity resolves to docs_change unless rollout evidence dominates.
    if (rollout >= 2 * docs) {
      return { eventType: "rollout", score: 0.6, reasons: [...reasons, "mixed signals; rollout evidence dominates → weak rollout"] };
    }
    return { eventType: "docs_change", score: 0.55, reasons: [...reasons, "mixed signals; docs evidence wins → LLM review"] };
  }
  // No signal at all: safest label is docs_change (never alert on unknown).
  return { eventType: "docs_change", score: 0.5, reasons: ["no classification signal; fail-safe → docs_change (never alerts)"] };
}

const LLM_SYSTEM = `You classify official search-platform announcements into exactly one of three classes:
- rollout: a CONFIRMED ranking algorithm change with rollout dates (core update, spam update, helpful content update, reviews update, Discover update, or a status-dashboard ranking incident).
- docs_change: a documentation edit — a changelog entry, a new guide, an added/updated/clarified property in docs. NEVER a ranking change, even if it mentions update families by name.
- volatility: a third-party flux reading (sensor/mozcast/unconfirmed chatter).
Reply with ONLY valid JSON: {"eventType":"rollout"|"docs_change"|"volatility","confidence":0..1,"reason":"one short sentence"}.`;

interface LlmVerdict {
  eventType: PlatformEventType;
  confidence: number;
  reason: string;
}

/** One cheap LLM call on the background workload; never throws. */
async function llmClassify(item: RawSourceItem): Promise<LlmVerdict | null> {
  try {
    const provider = getLlmProviderFor("background");
    if (!provider.isLive) return null; // mock → skip LLM, keep heuristic
    const raw = await provider.generate(
      `${LLM_SYSTEM}\n\nTitle: ${item.title}\nSummary: ${item.summary.slice(0, 800)}\nSource: ${item.source}`,
      { maxTokens: 256 },
    );
    const m = raw.match(/\{[\s\S]*?\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]) as Partial<LlmVerdict>;
    if (
      parsed.eventType !== "rollout" &&
      parsed.eventType !== "docs_change" &&
      parsed.eventType !== "volatility"
    ) {
      return null;
    }
    const confidence = Math.min(1, Math.max(0, Number(parsed.confidence) || 0.5));
    return {
      eventType: parsed.eventType,
      confidence,
      reason: String(parsed.reason ?? "llm verdict").slice(0, 200),
    };
  } catch {
    return null;
  }
}

/**
 * Full classification: heuristics first; LLM re-score when the heuristic is
 * uncertain. The LLM can disagree with a weak heuristic — but a docs_change
 * verdict on an official changelog source is never overridden upward.
 */
export async function classifyEvent(item: RawSourceItem): Promise<ClassifiedEvent> {
  const h = heuristicClassify(item);
  if (h.score >= LLM_REVIEW_FLOOR) {
    return {
      eventType: h.eventType,
      confidence: h.score,
      reasons: h.reasons,
      heuristicScore: h.score,
      llmUsed: false,
    };
  }
  const llm = await llmClassify(item);
  if (!llm) {
    return {
      eventType: h.eventType,
      confidence: h.score,
      reasons: [...h.reasons, "LLM unavailable (mock/offline) — heuristic verdict stands"],
      heuristicScore: h.score,
      llmUsed: false,
    };
  }
  // Guardrail: a Search Central changelog row is docs_change by definition —
  // the LLM may not reclassify it upward into rollout.
  if (item.source === "search_central" && llm.eventType === "rollout") {
    return {
      eventType: "docs_change",
      confidence: h.score,
      reasons: [...h.reasons, "LLM suggested rollout; overridden — changelog source is docs by definition"],
      heuristicScore: h.score,
      llmUsed: true,
    };
  }
  const confidence = (h.score + llm.confidence) / 2;
  return {
    eventType: llm.eventType,
    confidence,
    reasons: [`LLM verdict: ${llm.reason}`, ...h.reasons],
    heuristicScore: h.score,
    llmUsed: true,
  };
}

/** Synchronous heuristic-only classification (seeds, fast paths). */
export function classifyEventHeuristicOnly(item: RawSourceItem): ClassifiedEvent {
  const h = heuristicClassify(item);
  return {
    eventType: h.eventType,
    confidence: h.score,
    reasons: h.reasons,
    heuristicScore: h.score,
    llmUsed: false,
  };
}
