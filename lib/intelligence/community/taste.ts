// Marketr — Phase 10 M8: taste guardrails.
//
// Communities punish over-polished AI replies faster than any moderator.
// Every generated draft passes tasteCheck() before it may reach the Phase 9
// approval inbox; failures are logged (COMMUNITY_TASTE_REJECTED_EVENT) and
// the draft dies. The checks are deliberately strict and inspectable — a
// checklist, not a vibe.
//
// "Would a person with context write this?" heuristics:
//   - short (40–900 chars by default) and specific
//   - no emojis, no marketing-speak blocklist, no sycophantic openers
//   - at most 2 links (a real person doesn't carpet-bomb URLs)
//   - no ALL-CAPS shouting, no "!!", at most 2 exclamation marks
//   - no first-person-plural brand pitching ("we at Acme")

import type { TasteCheckResult } from "./types";

export interface TasteCheckOptions {
  /** Max draft chars (default 900). HN/Reddit reward brevity. */
  maxChars?: number;
  /** Min draft chars (default 40) — substance, not a drive-by. */
  minChars?: number;
}

const EMOJI_RE =
  /[\u{1F300}-\u{1F5FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}]/u;

/** Marketing-speak that reads as bot on Reddit/HN. Word-boundary matched. */
const MARKETING_SPEAK = [
  "game-changer",
  "game changer",
  "cutting-edge",
  "cutting edge",
  "revolutionize",
  "revolutionary",
  "leverage",
  "synergy",
  "synergies",
  "disrupt",
  "disruptive",
  "unlock",
  "supercharge",
  "best-in-class",
  "state-of-the-art",
  "world-class",
  "deep dive",
  "delve",
  "as an ai",
  "as a language model",
  "check out",
  "free trial",
  "click here",
  "act now",
  "limited time",
  "don't miss out",
  "fomo",
  "next level",
  "secret sauce",
];

/** Sycophantic openers — the #1 AI-reply tell on Reddit/HN. */
const SYCOPHANCY_OPENERS = [
  "great question",
  "great point",
  "excellent question",
  "thanks for sharing",
  "that's a great",
  "what a great",
  "fantastic question",
  "as someone who",
];

const BRAND_PITCH_RE = /\bwe at [A-Z][\w-]*/;
const ALL_CAPS_WORD_RE = /\b[A-Z]{4,}\b/;
const URL_RE = /https?:\/\/[^\s)]+/gi;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Check a draft against the taste checklist. Pure — safe to run anywhere.
 * Anything failing never reaches the approval inbox (caller logs it).
 */
export function tasteCheck(draft: string, opts: TasteCheckOptions = {}): TasteCheckResult {
  const failures: string[] = [];
  const text = (draft ?? "").trim();
  const maxChars = opts.maxChars ?? 900;
  const minChars = opts.minChars ?? 40;

  if (text.length < minChars) {
    failures.push(`too short (${text.length} chars < ${minChars}) — a real reply has substance`);
  }
  if (text.length > maxChars) {
    failures.push(`too long (${text.length} chars > ${maxChars}) — HN/Reddit reward brevity`);
  }

  if (EMOJI_RE.test(text)) {
    failures.push("contains emoji — reads as bot on Reddit/HN");
  }

  const lowered = text.toLowerCase();
  const marketingHits = MARKETING_SPEAK.filter((p) =>
    new RegExp(`\\b${escapeRegExp(p)}\\b`, "i").test(lowered),
  );
  if (marketingHits.length > 0) {
    failures.push(`marketing-speak detected: ${marketingHits.slice(0, 3).join(", ")}`);
  }

  const openerText = lowered.replace(/^[^a-z0-9]+/, ""); // strip leading emoji/punct
  const openerHit = SYCOPHANCY_OPENERS.find((o) => openerText.startsWith(o));
  if (openerHit) {
    failures.push(`sycophantic opener ("${openerHit}…") — the #1 AI-reply tell`);
  }

  const urls = text.match(URL_RE) ?? [];
  if (urls.length > 2) {
    failures.push(`${urls.length} links — a real person doesn't carpet-bomb URLs`);
  }

  const allCaps = text.match(ALL_CAPS_WORD_RE) ?? [];
  const legitAcronyms = new Set(["SEO", "API", "URL", "HTML", "SaaS", "AI", "LLM", "CEO", "FAQ", "HTTP", "HTTPS"]);
  const shouting = allCaps.filter((w) => !legitAcronyms.has(w));
  if (shouting.length > 0) {
    failures.push(`ALL-CAPS shouting: ${shouting.slice(0, 3).join(", ")}`);
  }

  if (text.includes("!!")) {
    failures.push('double exclamation ("!!") — reads as hype');
  } else if ((text.match(/!/g) ?? []).length > 2) {
    failures.push("more than 2 exclamation marks — reads as hype");
  }

  if (BRAND_PITCH_RE.test(text)) {
    failures.push('first-person-plural brand pitch ("we at …") — reads as astroturf');
  }

  // "Would a person with context write this?" — a draft that is all generic
  // advice with zero thread-specific reference fails the specificity check.
  // Heuristic: drafts under 3 sentences that contain none of the thread's
  // concrete nouns get flagged by the CALLER (it has the thread); here we
  // only catch the degenerate all-template case.
  const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);
  if (sentences.length === 0) {
    failures.push("empty draft");
  }

  return { ok: failures.length === 0, failures };
}
