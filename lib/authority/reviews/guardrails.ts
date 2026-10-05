// Marketr — R1 pre-draft guardrails (HARD BLOCKS).
//
// docs/specs/SPEC-PHASE6.md §2/R1, §9 invariant 6.
// These run BEFORE any draft is generated. A hit blocks the AI draft
// (draftBlocked = true); the queue item keeps the flags so a human can
// write the reply manually. Structural, not configurable.
//
// Blocks: staff names, PII (email/phone), incentives language, keyword-stuffed
// templates, review gating/filtering.

export interface GuardrailInput {
  reviewText: string;
  reviewerName: string | null;
  rating: number;
  /** Optional funnel copy for the velocity engine (gating check). */
  funnelCopy?: string | null;
}

export interface GuardrailResult {
  flags: string[];
  blocked: boolean;
}

// Staff names have been banned from GBP replies since 2026-04-17.
const NAME_PATTERN = /\b([A-Z][a-z]{2,})\s+([A-Z][a-z]{2,})\b/; // "First Last"
const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE_PATTERN =
  /(\+?1[\s.-]?)?(\(?\d{3}\)?[\s.-]?)?\d{3}[\s.-]?\d{4}/;

// Incentives language — "fake engagement, strictly prohibited" (2025-12-31).
const INCENTIVE_PATTERNS = [
  /free\b/i,
  /discount\s+(for|on)\s+(a\s+)?review/i,
  /in\s+exchange\s+for\s+(a\s+)?review/i,
  /for\s+a\s+review/i,
  /leave\s+us\s+(a\s+)?(5|five)\s*star/i,
  /get\s+\$\d+/i,
  /coupon\s+for\s+(your|a)\s+review/i,
  /gift\s+card/i,
  /reward\s+for\s+(your|a)\s+review/i,
];

// Review gating: routing unhappy customers away from Google is banned.
// Detect copy that only solicits positive reviewers or diverts negatives.
const GATING_PATTERNS = [
  /only\s+if\s+you\s+(had|enjoyed|love)/i,
  /if\s+you\s+weren'?t\s+happy/i,
  /before\s+leaving\s+(a\s+)?(google\s+)?review/i,
  /tell\s+us\s+first/i,
  /don'?t\s+leave\s+(a\s+)?(negative|bad|1\s*star)/i,
  /contact\s+us\s+instead\s+of\s+review/i,
];

function detectKeywordStuffing(text: string): boolean {
  // Repeated exact-match 3+ word phrases (the template-stuffing pattern).
  const words = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").split(/\s+/).filter(Boolean);
  if (words.length < 9) return false;
  const seen = new Map<string, number>();
  for (let i = 0; i + 2 < words.length; i++) {
    const phrase = words.slice(i, i + 3).join(" ");
    seen.set(phrase, (seen.get(phrase) ?? 0) + 1);
    if ((seen.get(phrase) ?? 0) >= 3) return true;
  }
  return false;
}

/** Pre-draft guardrail run. Any flag => draft is hard-blocked. */
export function runGuardrails(input: GuardrailInput): GuardrailResult {
  const flags: string[] = [];
  const text = input.reviewText ?? "";

  // 1. Staff names in the reply context (reviewer name != staff; only staff names block).
  // We flag when the REVIEW text itself contains a likely staff "First Last" name,
  // so the draft generator knows never to echo it (banned 2026-04-17).
  const staffNameMatch = NAME_PATTERN.exec(text);
  if (staffNameMatch && staffNameMatch[0].toLowerCase() !== (input.reviewerName ?? "").toLowerCase()) {
    flags.push("staff_name_in_review");
  }

  // 2. PII: email or phone patterns.
  if (EMAIL_PATTERN.test(text) || PHONE_PATTERN.test(text)) {
    flags.push("pii_detected");
  }

  // 3. Incentives language.
  if (INCENTIVE_PATTERNS.some((re) => re.test(text))) {
    flags.push("incentive_language");
  }

  // 4. Keyword-stuffed templates.
  if (detectKeywordStuffing(text)) {
    flags.push("keyword_stuffing");
  }

  // 5. Review gating / filtering.
  const funnel = input.funnelCopy ?? "";
  if (GATING_PATTERNS.some((re) => re.test(funnel))) {
    flags.push("review_gating_suspected");
  }

  return { flags, blocked: flags.length > 0 };
}

/** Human-readable explanation per flag (UI + audit detail). */
export const GUARDRAIL_EXPLANATIONS: Record<string, string> = {
  staff_name_in_review:
    "Review names a staff member — reply must not repeat staff names (GBP policy, 2026-04-17).",
  pii_detected: "Email or phone pattern detected — never echo PII in a public reply.",
  incentive_language:
    "Incentives language detected — fake engagement is strictly prohibited (2025-12-31).",
  keyword_stuffing: "Repeated exact-match phrases detected — keyword-stuffed templates are blocked.",
  review_gating_suspected:
    "Funnel copy appears to divert unhappy customers away from Google — review gating is banned. Sentiment-split funnels are feedback triage only.",
  auto_sanitized_after_rejection:
    "Draft was auto-sanitized after a Google moderation rejection and re-drafted for human re-approval.",
};
