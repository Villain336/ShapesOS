// Marketr — Funding/VC slice 4: deterministic pitch-deck review rubric.
// Spec: BUSINESS-OS-FEATURE-SPECS.md §3 (AI pitch-deck review against known
// investor patterns).
//
// Hard rules (never bend):
// 1. The rubric is DETERMINISTIC: `reviewDeck` is a pure function of its
//    input (deck metadata + optional deck text). Same input → byte-identical
//    output. No LLM, no randomness, no network.
// 2. NO INVENTION: every finding cites the signal it came from — a quoted
//    excerpt of the deck text (<=140 chars) or a metadata field. Anything not
//    found is verdict "not_detected" with note "Not detected", never assumed.
// 3. The narrative is a template over the deterministic findings.
//
// Why no LLM: the repo's intelligence layer has provider-specific adapters
// (dataforseo/serper/talordata) but no general text-completion interface, so
// v1 ships fully deterministic. The scores must be computed deterministically
// anyway per spec — v1 simply skips the optional LLM narrative draft.

import { createHash } from "node:crypto";
import { FundingError } from "./types";

export const DECK_REVIEW_CRITERIA = [
  "problem_clarity",
  "traction_evidence",
  "market_sizing",
  "team",
  "ask",
  "financials_presence",
] as const;

export type DeckReviewCriterion = (typeof DECK_REVIEW_CRITERIA)[number];

export const DECK_CRITERION_LABELS: Record<DeckReviewCriterion, string> = {
  problem_clarity: "Problem clarity",
  traction_evidence: "Traction evidence",
  market_sizing: "Market sizing",
  team: "Team",
  ask: "The ask",
  financials_presence: "Financials presence",
};

/** What the investor pattern expects to see for each criterion. */
export const DECK_CRITERION_EXPECTATIONS: Record<DeckReviewCriterion, string> = {
  problem_clarity:
    "A crisply stated customer problem or pain point — who hurts, how, and why now.",
  traction_evidence:
    "Proof of momentum: revenue, users, growth rates, or signed demand — with numbers, not adjectives.",
  market_sizing:
    "How big the prize is: TAM/SAM/SOM or a credible bottom-up market figure.",
  team: "Who is building this and why they are the ones to win — founders, key hires, relevant experience.",
  ask: "What you are raising and what the money does — round size, use of funds.",
  financials_presence:
    "The numbers behind the story: burn, runway, unit economics, or a forecast — investors check that the math exists.",
};

export type DeckReviewVerdict = "pass" | "partial" | "not_detected";

export interface DeckSignal {
  /** "deck_text" = quoted from the founder-supplied text; "metadata" = a file/version field. */
  source: "deck_text" | "metadata";
  /** Quoted excerpt (<=140 chars) for deck_text; field name for metadata. */
  excerpt?: string;
  field?: string;
  value?: string;
}

export interface DeckCriterionResult {
  criterion: DeckReviewCriterion;
  label: string;
  expectation: string;
  /** 0–2: 0 = not detected, 1 = partial, 2 = strong. */
  score: number;
  maxScore: 2;
  verdict: DeckReviewVerdict;
  /** Every signal this finding cites. Empty for not_detected. */
  signals: DeckSignal[];
  /** Human note — for not_detected this always says what was missing. */
  note: string;
}

export interface DeckReviewInput {
  fileName: string;
  mimeType: string | null;
  sizeBytes: number;
  versionNumber: number;
  uploadedAt: string; // ISO
  /** Optional founder-supplied deck text (pasted copy or extracted text).
   * When absent, text-driven criteria are not_detected — never guessed. */
  deckText?: string | null;
}

export interface DeckReviewOutput {
  results: DeckCriterionResult[];
  /** 0–100, deterministic. */
  overallScore: number;
  narrative: string;
  deckTextProvided: boolean;
  /** sha256 of the normalized input — identical inputs, identical reviews. */
  inputHash: string;
}

// Signal patterns per criterion: [pattern, signal description]. A criterion
// scores by DISTINCT patterns matched (not raw hit count) so a deck that
// repeats "revenue" ten times doesn't outscore one that shows revenue +
// growth + customers.
const CRITERION_PATTERNS: Record<DeckReviewCriterion, { re: RegExp; signal: string }[]> = {
  problem_clarity: [
    { re: /\bproblem\b/i, signal: "names the problem" },
    { re: /\bpain\s?points?\b/i, signal: "names a pain point" },
    { re: /\b(challenge|struggle|frustrat\w+)\b/i, signal: "describes the struggle" },
    { re: /\bwhy\s+now\b/i, signal: "states why now" },
  ],
  traction_evidence: [
    { re: /\b(mrr|arr)\b/i, signal: "quotes MRR/ARR" },
    { re: /\brevenue\b/i, signal: "mentions revenue" },
    { re: /\bgrowth\b/i, signal: "mentions growth" },
    { re: /\b(customers?|users?|clients?)\b/i, signal: "names customers/users" },
    { re: /(\$[\d,]+(\.\d+)?[kmb]?|\b\d+(\.\d+)?\s?%|\b\d+\s?x\b)/i, signal: "includes a quantified figure" },
    { re: /\b(pilot|beta|waitlist|loi|letter of intent)\b/i, signal: "shows early demand" },
  ],
  market_sizing: [
    { re: /\btam\b/i, signal: "states TAM" },
    { re: /\bsam\b/i, signal: "states SAM" },
    { re: /\bsom\b/i, signal: "states SOM" },
    { re: /\bmarket\s+(size|opportunity)\b/i, signal: "discusses market size" },
    { re: /\$\s?[\d,]+(\.\d+)?\s?(billion|million|bn|mm)\b/i, signal: "quantifies the market in $B/$M" },
  ],
  team: [
    { re: /\bteam\b/i, signal: "has a team section" },
    { re: /\bfounders?\b/i, signal: "names founders" },
    { re: /\b(ceo|cto|cfo|coo)\b/i, signal: "names titled roles" },
    { re: /\b(experience|previously|ex-|former)\b/i, signal: "cites relevant experience" },
    { re: /\badvisor/i, signal: "names advisors" },
  ],
  ask: [
    { re: /\braising\b/i, signal: "states it is raising" },
    { re: /\bseeking\b/i, signal: "states the seek" },
    { re: /\buse of funds\b/i, signal: "details use of funds" },
    { re: /\b(ask|round)\b/i, signal: "names the ask/round" },
    { re: /\$\s?[\d,]+(\.\d+)?\s?(m|mm|million)\b/i, signal: "quantifies the raise" },
  ],
  financials_presence: [
    { re: /\bburn\b/i, signal: "mentions burn" },
    { re: /\brunway\b/i, signal: "mentions runway" },
    { re: /\b(p&l|pnl|profit and loss)\b/i, signal: "mentions P&L" },
    { re: /\bunit economics\b/i, signal: "mentions unit economics" },
    { re: /\bforecast\b/i, signal: "mentions a forecast" },
    { re: /\b(gross margin|cac|lifetime value|ltv)\b/i, signal: "names financial metrics" },
  ],
};

const MAX_EXCERPT = 140;

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Find the sentence-ish window around a match for citation. */
function excerptAround(text: string, index: number, matchLen: number): string {
  const start = Math.max(0, index - 60);
  const end = Math.min(text.length, index + matchLen + 60);
  let excerpt = text.slice(start, end).trim();
  if (excerpt.length > MAX_EXCERPT) {
    excerpt = excerpt.slice(0, MAX_EXCERPT - 1).trimEnd() + "…";
  }
  return excerpt;
}

function scoreCriterion(
  criterion: DeckReviewCriterion,
  deckText: string | null,
): DeckCriterionResult {
  const label = DECK_CRITERION_LABELS[criterion];
  const expectation = DECK_CRITERION_EXPECTATIONS[criterion];
  const base = {
    criterion,
    label,
    expectation,
    maxScore: 2 as const,
    signals: [] as DeckSignal[],
  };

  if (!deckText) {
    return {
      ...base,
      score: 0,
      verdict: "not_detected",
      note: `Not detected — no deck text was supplied for review, so "${label.toLowerCase()}" could not be evaluated. Paste the deck copy to enable this check.`,
    };
  }

  const matched: { signal: string; excerpt: string }[] = [];
  for (const { re, signal } of CRITERION_PATTERNS[criterion]) {
    const m = re.exec(deckText);
    if (m && m.index !== undefined) {
      matched.push({
        signal,
        excerpt: `…${excerptAround(deckText, m.index, m[0].length)}…`,
      });
      // Reset lastIndex for non-global regexes (exec is stateless here, but
      // be explicit for safety).
      re.lastIndex = 0;
    }
  }

  if (matched.length === 0) {
    return {
      ...base,
      score: 0,
      verdict: "not_detected",
      note: `Not detected — none of the expected ${label.toLowerCase()} signals appeared in the supplied deck text.`,
    };
  }

  const signals: DeckSignal[] = matched.map((m) => ({
    source: "deck_text" as const,
    excerpt: m.excerpt,
  }));

  if (matched.length === 1) {
    return {
      ...base,
      score: 1,
      verdict: "partial",
      signals,
      note: `Partial — one ${label.toLowerCase()} signal found (${matched[0].signal}); investors expect more depth here.`,
    };
  }

  return {
    ...base,
    score: 2,
    verdict: "pass",
    signals,
    note: `Strong — ${matched.length} distinct ${label.toLowerCase()} signals found (${matched.map((m) => m.signal).join("; ")}).`,
  };
}

function metadataSignals(input: DeckReviewInput): DeckSignal[] {
  return [
    { source: "metadata", field: "fileName", value: input.fileName },
    { source: "metadata", field: "versionNumber", value: String(input.versionNumber) },
    { source: "metadata", field: "sizeBytes", value: String(input.sizeBytes) },
    { source: "metadata", field: "uploadedAt", value: input.uploadedAt },
  ];
}

function buildNarrative(
  results: DeckCriterionResult[],
  overallScore: number,
  deckTextProvided: boolean,
  fileName: string,
  versionNumber: number,
): string {
  const pass = results.filter((r) => r.verdict === "pass");
  const partial = results.filter((r) => r.verdict === "partial");
  const missing = results.filter((r) => r.verdict === "not_detected");
  const lines = [
    `Deterministic review of "${fileName}" (v${versionNumber}) against 6 known investor patterns. Overall: ${overallScore}/100.`,
  ];
  if (!deckTextProvided) {
    lines.push(
      "No deck text was supplied, so text-driven checks could not run — every text criterion is reported as not detected rather than guessed. Paste the deck copy and re-run for a full review.",
    );
  }
  if (pass.length) {
    lines.push(`Strong: ${pass.map((r) => r.label).join(", ")}.`);
  }
  if (partial.length) {
    lines.push(
      `Needs depth: ${partial.map((r) => `${r.label} (${r.note.split("—")[1]?.trim() ?? r.note})`).join("; ")}.`,
    );
  }
  if (missing.length) {
    lines.push(
      `Missing: ${missing.map((r) => r.label).join(", ")} — ${
        deckTextProvided
          ? "add explicit coverage of these before investor meetings."
          : "supply deck text to evaluate these."
      }`,
    );
  }
  return lines.join(" ");
}

/**
 * Deterministic pitch-deck review. Pure: no I/O, no randomness. Two calls
 * with deep-equal input produce byte-identical output (see inputHash).
 */
export function reviewDeck(input: DeckReviewInput): DeckReviewOutput {
  const deckText =
    typeof input.deckText === "string" && normalizeText(input.deckText).length > 0
      ? normalizeText(input.deckText)
      : null;

  const results = DECK_REVIEW_CRITERIA.map((c) => scoreCriterion(c, deckText));

  // Attach the deck's identity signals to every result so each finding
  // carries its provenance even when no text signal matched.
  const meta = metadataSignals(input);
  for (const r of results) {
    r.signals = [...r.signals, ...meta];
  }

  const total = results.reduce((s, r) => s + r.score, 0);
  const max = results.length * 2;
  const overallScore = Math.round((total / max) * 100);

  const narrative = buildNarrative(
    results,
    overallScore,
    deckText !== null,
    input.fileName,
    input.versionNumber,
  );

  const normalized = JSON.stringify({
    fileName: input.fileName.trim(),
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
    versionNumber: input.versionNumber,
    uploadedAt: input.uploadedAt,
    deckText,
  });
  const inputHash = createHash("sha256").update(normalized).digest("hex");

  return {
    results,
    overallScore,
    narrative,
    deckTextProvided: deckText !== null,
    inputHash,
  };
}

/** Validate the review-runner payload (deckText optional, capped). */
export function validateDeckReviewInput(input: { deckText?: unknown }): {
  deckText: string | null;
} {
  if (input.deckText === undefined || input.deckText === null) {
    return { deckText: null };
  }
  if (typeof input.deckText !== "string") {
    throw new FundingError("INVALID_DECK_TEXT", "deckText must be a string.");
  }
  const text = input.deckText.trim();
  if (text.length > 100_000) {
    throw new FundingError("INVALID_DECK_TEXT", "deckText must be 100,000 characters or fewer.");
  }
  return { deckText: text || null };
}
