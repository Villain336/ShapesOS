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
//
// Phase 15 slice 6 — auto-read accuracy gate (spec §6): isToolkitAutoReadLive()
// below. A toolkit's derived LOW tier only goes live (silent auto-execution)
// once the sampled tier-accuracy eval passes for it (agreement ≥ target,
// committed result, fresh vs the gold set) — otherwise the classification
// path escalates reads to medium (gated, still executable with approval).

import type { RiskTier } from "./risk";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

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

// ---------------------------------------------------------------------------
// Auto-read accuracy gate — Phase 15 slice 6 (spec §6: "classifier
// agreement ≥ target before a toolkit's auto-read tier goes live").
//
// isToolkitAutoReadLive(toolkitSlug) answers whether a toolkit's derived
// LOW tier may execute silently. It reads the COMMITTED eval-results JSON
// (scripts/eval-results/phase15-tier-accuracy.json, written by
// scripts/eval-phase15-tier-accuracy.mts) and is fail-closed:
//
//   - results file missing / unparseable → NOT live
//   - no per-toolkit entry, or passed !== true → NOT live
//   - goldSha mismatch (gold set changed since the eval ran) → NOT live
//     — this is the staleness rule: editing the gold set without
//     re-running the eval can never silently keep a toolkit live.
//
// Loading: the JSON is require()d lazily (createRequire, try/catch) rather
// than statically imported so the eval script — which CREATES the results
// file — can import deriveTier from this module on a first run when the
// file does not exist yet. EVAL_RESULTS_PATH overrides the results path
// (batteries point it at temp copies; never committed).
//
// The gold set is loaded the same lazy way; its canonical sha (goldShaFor)
// must equal the results' goldSha or the result is stale.
// ---------------------------------------------------------------------------

export interface ToolkitTierAccuracy {
  agreement: number;
  n: number;
  passed: boolean;
}

export interface TierAccuracyResults {
  ranAt: string;
  target: number;
  overall: number;
  entryCount: number;
  goldSha: string;
  perToolkit: Record<string, ToolkitTierAccuracy>;
}

const cjsRequire = createRequire(import.meta.url);

function loadJsonLenient(path: string): unknown | null {
  try {
    return cjsRequire(path) as unknown;
  } catch {
    return null;
  }
}

/** Canonical content hash of the gold set. The eval script writes this
 *  into the results JSON; the gate recomputes it — any drift between the
 *  two means "gold changed since the eval ran" → stale → not live. */
export function goldShaFor(goldJson: unknown): string {
  return createHash("sha256").update(JSON.stringify(goldJson)).digest("hex");
}

function bundledGold(): unknown | null {
  return loadJsonLenient("../../../scripts/eval-data/phase15-tier-gold.json");
}

/** The committed results, or the EVAL_RESULTS_PATH override (batteries). */
function loadResults(): TierAccuracyResults | null {
  const override = process.env.EVAL_RESULTS_PATH?.trim();
  const raw = override
    ? (() => {
        try {
          return JSON.parse(readFileSync(override, "utf8")) as unknown;
        } catch {
          return null;
        }
      })()
    : loadJsonLenient("../../../scripts/eval-results/phase15-tier-accuracy.json");
  if (!raw || typeof raw !== "object") return null;
  return raw as TierAccuracyResults;
}

// The bundled gold's sha, computed once — the freshness anchor. Null when
// the gold file itself is missing (then nothing can be live).
let bundledGoldSha: string | null | undefined;
function getBundledGoldSha(): string | null {
  if (bundledGoldSha === undefined) {
    const gold = bundledGold();
    bundledGoldSha = gold === null ? null : goldShaFor(gold);
  }
  return bundledGoldSha;
}

/**
 * Is this toolkit's auto-read tier live? True only when the committed
 * eval results show passed=true for the toolkit AND the results are fresh
 * vs the committed gold set. Fail-closed on every error path (missing
 * file, bad JSON, missing entry, stale hash, null/empty slug).
 */
export function isToolkitAutoReadLive(
  toolkitSlug: string | null | undefined,
): boolean {
  if (!toolkitSlug) return false;
  const results = loadResults();
  if (!results) return false;
  const anchor = getBundledGoldSha();
  if (!anchor) return false;
  if (results.goldSha !== anchor) return false;
  const entry = results.perToolkit?.[toolkitSlug];
  return entry?.passed === true;
}
