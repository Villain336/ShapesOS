// Marketr — Phase 15 slice 2: pattern-based tier derivation (spec §2).
//
// The v1 rule engine (risk.ts) derived tiers from verb stems in the tool
// slug. At catalog scale (100+ apps, thousands of tools) derivation adds:
//   - explicit READ_PATTERNS (fetch/query/describe/retrieve — v1 defaulted
//     anything unmatched to low, which is no longer safe),
//   - description-text fallback when the slug is ambiguous,
//   - a small explicit per-app override table (reviewable; seeded with
//     money-movement cases pattern matching can't see),
//   - confidence ("high" from slug, "low" from description/unclassified),
//   - a universal conservative floor: anything matching nothing lands
//     HIGH-GATED (locked: unclassified tools → approval + second
//     confirmation), never auto-executable.
//
// deriveTier() is pure and fixture-testable. risk.ts's classifyAction()
// consumes it and enforces the override floor (escalate, never downgrade).

import type { RiskTier } from "./risk";

/** Verb stems that mark a tool destructive. Checked before write verbs so
 *  e.g. DELETE_LABEL (destructive) beats a generic match. */
export const DESTRUCTIVE_PATTERNS = [
  "DELETE",
  "REMOVE",
  "REVOKE",
  "ARCHIVE",
  "CANCEL",
  "DESTROY",
  "PURGE",
  "TRASH",
  "UNSUBSCRIBE",
  "BLOCK",
];

/** Verb stems that mark a tool a write. */
export const WRITE_PATTERNS = [
  "SEND",
  "CREATE",
  "UPDATE",
  "POST",
  "PUBLISH",
  "UPLOAD",
  "ADD",
  "INSERT",
  "SET",
  "MODIFY",
  "EDIT",
  "PATCH",
  "SUBMIT",
  "SHARE",
  "INVITE",
  "SCHEDULE",
  "REPLY",
  "APPEND",
];

/** Verb stems that mark a tool a read. Phase 15: explicit, because the v1
 *  default ("no match → low") is gone — anything unmatched now floors to
 *  high, so reads must declare themselves. */
export const READ_PATTERNS = [
  "LIST",
  "GET",
  "SEARCH",
  "DESCRIBE",
  "FETCH",
  "RETRIEVE",
  "QUERY",
];

export function isValidTier(t: unknown): t is RiskTier {
  return t === "low" || t === "medium" || t === "high";
}

export interface DerivedTier {
  tier: RiskTier;
  /** "high" when the slug itself matched; "low" when the tier came from
   *  the description fallback or from the conservative floor. */
  confidence: "high" | "low";
  /** False exactly when nothing matched and the floor caught the tool. */
  classified: boolean;
}

// ---------------------------------------------------------------------------
// Per-app tier table — reviewable, curated, seeds override the fuzzy
// derivation. Keyed by appKey (lowercase) → tool slug (uppercase) → tier.
// Reviewed in the Actions UI (later slice); entries here are deliberate,
// documented choices for tools the verb patterns can't see — e.g.
// money movement out of the user's account.
// ---------------------------------------------------------------------------

export const PER_APP_TIER_OVERRIDES: Record<string, Record<string, RiskTier>> = {
  stripe: {
    // Refunding moves money OUT of the merchant's account: treat as
    // destructive-equivalent. Neither slug nor description carries a
    // destructive/write verb ("refund" isn't one), so without this entry
    // the conservative floor would catch it anyway — this makes it
    // deliberate and high-confidence instead.
    STRIPE_REFUND_PAYMENT: "high",
  },
};

function matchesAny(text: string, patterns: string[]): boolean {
  return patterns.some((p) => text.includes(p));
}

/**
 * Derive a tool's risk tier.
 *
 * Order: per-app table → destructive verbs (slug) → write verbs (slug) →
 * read verbs (slug) → description fallback (destructive/write/read) →
 * conservative floor { high, classified: false }.
 *
 * The floor is load-bearing: classified=false forces the high tier, and
 * classifyAction() translates that into autoExecutable=false, so the
 * gate's existing high-tier second-confirmation path (executeApproved's
 * destructiveConfirm) is REQUIRED — no new bypass exists.
 */
export function deriveTier(
  toolSlug: string,
  description?: string | null,
  appKey?: string | null,
): DerivedTier {
  const slug = toolSlug.toUpperCase();

  const tabled = appKey ? PER_APP_TIER_OVERRIDES[appKey.toLowerCase()]?.[slug] : undefined;
  if (tabled !== undefined && isValidTier(tabled)) {
    return { tier: tabled, confidence: "high", classified: true };
  }

  if (matchesAny(slug, DESTRUCTIVE_PATTERNS)) return { tier: "high", confidence: "high", classified: true };
  if (matchesAny(slug, WRITE_PATTERNS)) return { tier: "medium", confidence: "high", classified: true };
  if (matchesAny(slug, READ_PATTERNS)) return { tier: "low", confidence: "high", classified: true };

  if (description) {
    const desc = description.toUpperCase();
    if (matchesAny(desc, DESTRUCTIVE_PATTERNS)) return { tier: "high", confidence: "low", classified: true };
    if (matchesAny(desc, WRITE_PATTERNS)) return { tier: "medium", confidence: "low", classified: true };
    if (matchesAny(desc, READ_PATTERNS)) return { tier: "low", confidence: "low", classified: true };
  }

  // Universal conservative floor (locked): unclassified → HIGH-GATED.
  return { tier: "high", confidence: "low", classified: false };
}
