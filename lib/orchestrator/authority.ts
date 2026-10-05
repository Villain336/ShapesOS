// Marketr — Phase 9 M1: Delegation of Authority (DoA) tier evaluator
// (docs/specs/SPEC-PHASE9.md §P9E, §3.4).
//
// PURE function — no LLM, no prompts, no I/O. Evaluated per action AT
// EXECUTION TIME by the approval executor (lib/authority/executor.ts), never
// trusted from agent-supplied labels.
//
// Tiers:
//   0 — Observe: pure reads, drafts, analysis. Always allowed in-mission.
//   1 — Small actions: amount <= threshold AND kind in the small-action
//       allowlist AND the user enabled the automation toggle.
//   2 — Significant: everything else (external audience, publish, spend
//       above threshold). Requires explicit human approval, every time.
//   3 — Never: hard deny list (move money, sign contracts, delete data).
//       UN-OVERRIDABLE — no setting, toggle, or prompt text can widen it.
//       The action's NATURE decides, not its label: adversarial phrasing in
//       `description` (e.g. "this is just a draft" on a buy order) still
//       evaluates Tier 3.

export type DoATier = 0 | 1 | 2 | 3;

export interface TierAction {
  kind: string;
  amountCents?: number;
  currency?: string;
  channel?: string;
  description?: string;
}

export interface TierSettings {
  /** Small-action threshold in USD cents (spec §8 decision: default 10000 = $100). */
  smallActionThresholdCents: number;
  /** Whether the user enabled the automation toggle for this action (M6: per-action).
   *  Default false — Tier 1 never fires without an explicit opt-in. */
  automationAllows?: boolean;
  /** Threshold currency (ISO code). Default "USD". */
  defaultCurrency?: string;
  /** Currency -> default-currency multiplier per 1 major unit of the action
   *  currency (e.g. EUR: 1.08 means €1 = $1.08). Unknown currency -> Tier 2,
   *  never assumed. */
  rates?: Record<string, number>;
}

/** Default small-action threshold: $100 (spec §8, Tico's decision). */
export const DEFAULT_SMALL_ACTION_THRESHOLD_CENTS = 10_000;

/**
 * Small-action kinds auto-allowable under Tier 1 (M6 makes this data-driven
 * via automation_settings; this list is the conservative v1 default).
 * These are low-blast-radius by nature: owned channels, internal notes,
 * small listing edits. Anything external-facing or money-adjacent is NOT
 * here and can never be Tier 1.
 */
export const TIER1_KINDS: ReadonlySet<string> = new Set([
  "publish_owned",
  "post_owned_social",
  "schedule_owned_content",
  "update_listing",
  "send_internal_note",
  "refresh_owned_page",
  // Phase 13 (twincore): internal site operations on the digital twin —
  // booking a truck onto a free dock and giving a forklift a task. No money,
  // no external audience; reversible (cancel the booking, free the forklift).
  "book_dock",
  "assign_equipment",
]);

/** Normalized lookup — normalizeForTier maps _/- to spaces, so the
 *  allowlist is normalized with the same function. Computed lazily to avoid
 *  module-init ordering issues. */
let tier1Normalized: ReadonlySet<string> | null = null;
function tier1KindsNormalized(): ReadonlySet<string> {
  if (!tier1Normalized) {
    tier1Normalized = new Set([...TIER1_KINDS].map((k) => normalizeForTier(k)));
  }
  return tier1Normalized;
}
/** Kind prefixes that are pure observation/analysis/drafting -> Tier 0. */
const TIER0_KIND_PREFIXES = [
  "read",
  "get",
  "list",
  "fetch",
  "query",
  "search",
  "view",
  "analyze",
  "analysis",
  "summarize",
  "summary",
  "draft",
  "plan",
  "check",
  "audit",
  "report",
  "inspect",
  "recall",
  "explain",
  "compare",
  "score",
  "classify",
];

// ---------------------------------------------------------------------------
// Tier 3: the hard deny list. UN-OVERRIDABLE.
// ---------------------------------------------------------------------------

/**
 * Money movement, contract signing, data deletion — matched against the
 * normalized kind AND the normalized description, because the agent's label
 * is untrusted. "tier 0 action: buy $5000 in ads" is Tier 3: the `buy` in
 * the description is the action's nature.
 */
const TIER3_PATTERNS: RegExp[] = [
  // --- money movement (spec §P9E: spend / purchase / buy / transfer / refund / payout)
  /\bpurchas\w*/, // purchase, purchases, purchased, purchasing
  /\bbuy(s|ing)?\b/, // buy, buys, buying (not "buyer")
  /\bbought\b/,
  /\bspend\w*/, // spend, spends, spending
  /\bspent\b/,
  /\btransfer\w*/, // transfer, transfers, transferred
  /\brefund\w*/, // refund, refunds, refunded
  /\bpayouts?\b/, // payout, payouts
  /\bpay\s?outs?\b/, // pay out, payouts
  /\bwithdraw\w*/, // withdraw, withdrawal
  /\bdeposit\w*\s+(into|to)\b/, // deposit into (an ad account) — money out
  // --- signing contracts
  /\bsign\w*\b.{0,40}\b(contracts?|agreements?|mou|io\b|terms)\b/,
  /\b(contracts?|agreements?)\b.{0,40}\bsign\w*\b/,
  /\bexecut\w+\s+(a|an|the|this)\s+(contract|agreement)\b/, // "execute the contract" = sign
  // --- deleting data
  /\bdelet\w*/, // delete, deletes, deleted, deletion
  /\bdestroy\w*/, // destroy, destroys, destroyed
  /\bpurg\w*/, // purge, purged, purging
  /\bwip\w*\b/, // wipe, wiped (word boundary: not "wiping"? \bwip\w*\b matches wiping too)
  /\beras\w*/, // erase, erased
  /\bshred\w*/, // shred
  /\btruncat\w*/, // truncate
  /\bdrop\s+(the\s+|a\s+)?(table|database|db|collection|index)\b/,
];

/** Homoglyphs that NFKC does not fold: Cyrillic/Greek lookalikes -> ASCII. */
const HOMOGLYPH_MAP: Record<string, string> = {
  "\u0430": "a", // а CYRILLIC SMALL LETTER A
  "\u0441": "c", // с CYRILLIC SMALL LETTER ES
  "\u0435": "e", // е CYRILLIC SMALL LETTER IE
  "\u0456": "i", // і CYRILLIC SMALL LETTER BYELORUSSIAN-UKRAINIAN I
  "\u0458": "j", // ј CYRILLIC SMALL LETTER JE
  "\u043e": "o", // о CYRILLIC SMALL LETTER O
  "\u0440": "p", // р CYRILLIC SMALL LETTER ER
  "\u0455": "s", // ѕ CYRILLIC SMALL LETTER DZE
  "\u0445": "x", // х CYRILLIC SMALL LETTER HA
  "\u0443": "y", // у CYRILLIC SMALL LETTER U
  "\u03b1": "a", // α GREEK SMALL LETTER ALPHA
  "\u03b5": "e", // ε GREEK SMALL LETTER EPSILON
  "\u03b9": "i", // ι GREEK SMALL LETTER IOTA
  "\u03bf": "o", // ο GREEK SMALL LETTER OMICRON
  "\u03c1": "p", // ρ GREEK SMALL LETTER RHO
  "\u03c5": "u", // υ GREEK SMALL LETTER UPSILON
  "\u03c7": "x", // χ GREEK SMALL LETTER CHI
};

/**
 * Normalize for adversarial matching:
 *  1. NFKD + strip combining marks (diacritics),
 *  2. NFKC (fullwidth -> ASCII, compatibility folds),
 *  3. strip zero-width / format characters,
 *  4. fold homoglyphs,
 *  5. lowercase, separators -> spaces, collapse whitespace.
 */
export function normalizeForTier(text: string): string {
  let s = text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  s = s.normalize("NFKC");
  s = s.replace(/[\u200b-\u200f\u2060\ufeff\u00ad]/g, ""); // zero-width / soft hyphen
  s = s
    .split("")
    .map((ch) => HOMOGLYPH_MAP[ch] ?? ch)
    .join("");
  s = s.toLowerCase().replace(/[_\-/\\|.,;:!?()[\]{}"'`~+=*^<>]/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

/**
 * Phase 10 (finance): exact kinds that move money or the books without a
 * Tier-3 verb in their name — recording a customer payment and posting /
 * reversing journal entries. Never automated, whatever a rule says.
 */
// Phase 11 (bizsync): + posting the books to QuickBooks / Xero.
// Phase 12 (mfgpos): + completing a manufacturing order (stock + costing to
// the books) and closing a till session (the takings to the books).
// Phase 12 (people): + approving and posting payroll.
// Phase 14 (connectors): + sending a pay run to the payroll provider (Gusto
// pays people from what is sent). The words "send payroll" match no money
// pattern, so it is listed here explicitly.
const TIER3_EXACT_KINDS: ReadonlySet<string> = new Set([
  "record payment",
  "post journal entry",
  "reverse journal entry",
  "pay vendor bill",
  "post to accounting",
  "complete manufacturing order",
  "close pos session",
  "approve pay run",
  "post pay run",
  "send payroll to provider",
]);

function isTier3(kind: string, description: string): boolean {
  if (TIER3_EXACT_KINDS.has(normalizeForTier(kind))) return true;
  const hay = `${normalizeForTier(kind)} ${normalizeForTier(description)}`.trim();
  if (!hay) return false;
  return TIER3_PATTERNS.some((re) => re.test(hay));
}

/**
 * Exact kinds that are Tier 0 although their verb isn't an observation:
 * Phase 8 edits to files inside an isolated code sandbox — local to it,
 * checkpointed and restorable, nothing leaves the sandbox. (Commands in the
 * sandbox, run_sandbox_command, stay Tier 2.)
 */
const TIER0_EXACT_KINDS: ReadonlySet<string> = new Set(["edit sandbox files"]);

function isTier0Kind(kind: string): boolean {
  if (TIER0_EXACT_KINDS.has(normalizeForTier(kind))) return true;
  const k = normalizeForTier(kind).split(" ")[0] ?? "";
  return TIER0_KIND_PREFIXES.some((p) => k === p || k.startsWith(p));
}

/**
 * Convert an action amount to default-currency cents.
 * Returns null when the currency is unknown — the caller must NOT assume;
 * unknown currency always escalates to Tier 2.
 */
export function amountInDefaultCents(
  amountCents: number,
  currency: string | undefined,
  settings: TierSettings,
): number | null {
  const cur = (currency ?? settings.defaultCurrency ?? "USD").toUpperCase();
  const defaultCur = (settings.defaultCurrency ?? "USD").toUpperCase();
  if (cur === defaultCur) return Math.max(0, Math.round(amountCents));
  const rate = settings.rates?.[cur];
  if (rate === undefined || !Number.isFinite(rate) || rate <= 0) return null;
  return Math.max(0, Math.round(amountCents * rate));
}

/**
 * evaluateTier — the DoA tier evaluator. PURE: no LLM, no I/O, no prompts.
 *
 * Evaluation order is load-bearing:
 *   1. Tier 3 scan (kind + description) — un-overridable, runs FIRST.
 *   2. Tier 1: amount <= threshold AND kind allowlisted AND automation toggle on.
 *   3. Tier 0: pure reads / drafts / analysis.
 *   4. Tier 2: everything else significant.
 */
export function evaluateTier(action: TierAction, settings: TierSettings): DoATier {
  if (!action || typeof action.kind !== "string" || !action.kind.trim()) {
    // Unknown action shape -> fail closed at Tier 2 (never Tier 0, never Tier 3).
    return 2;
  }

  // 1. Tier 3: hard deny. No setting, toggle, or prompt text can widen this.
  if (isTier3(action.kind, action.description ?? "")) return 3;

  // 2. Tier 1: small actions, allowlisted kinds, toggle ON.
  const automationAllows = settings.automationAllows === true;
  const kindNorm = normalizeForTier(action.kind);
  if (automationAllows && tier1KindsNormalized().has(kindNorm)) {
    if (action.amountCents === undefined || action.amountCents === null) {
      return 1; // no money involved (e.g. publish to owned channels)
    }
    const inDefault = amountInDefaultCents(action.amountCents, action.currency, settings);
    if (inDefault !== null && inDefault <= settings.smallActionThresholdCents) return 1;
    // Amount over threshold, or unknown currency -> falls through to Tier 2.
  }

  // 3. Tier 0: pure observation.
  if (isTier0Kind(action.kind)) return 0;

  // 4. Tier 2: significant — requires explicit human approval, every time.
  return 2;
}
