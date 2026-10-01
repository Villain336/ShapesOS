// Marketr — Legal/Compliance slice 4: change radar domain types.
// Spec: BUSINESS-OS-FEATURE-SPECS.md §4. v1 = structured seed feed + triage
// logic — NO live scraping. The seed feed is illustrative example content,
// visibly labeled as such in the UI, never presented as live tracking.
//
// Hard guardrails (never bend):
// 1. Information, NEVER legal advice — LEGAL_DISCLAIMER ships on every
//    output (page, API response, seed copy).
// 2. Never invent regulation specifics: no fabricated bill numbers, statute
//    citations, agency names-as-fact, or effective dates. Anything unverified
//    is flagged "verify before acting" — seed effective dates are null unless
//    the date itself was verified.
// 3. Insurance invariant — "Licensed partner: they hold the licenses, we
//    provide the software." No binding path.

import {
  LEGAL_DISCLAIMER,
  NATIONAL_JURISDICTION,
  type ComputedObligation,
  type LegalProfileInput,
  type SeedObligationTemplate,
} from "./types";

export { LEGAL_DISCLAIMER, NATIONAL_JURISDICTION };
export type { ComputedObligation, LegalProfileInput, SeedObligationTemplate };

export type RegulationChangeCategory =
  | "privacy"
  | "licensing"
  | "tax"
  | "employment"
  | "insurance"
  | "safety"
  | "other";

export const REGULATION_CHANGE_CATEGORIES: {
  value: RegulationChangeCategory;
  label: string;
}[] = [
  { value: "privacy", label: "Privacy" },
  { value: "licensing", label: "Licensing" },
  { value: "tax", label: "Tax" },
  { value: "employment", label: "Employment" },
  { value: "insurance", label: "Insurance" },
  { value: "safety", label: "Safety" },
  { value: "other", label: "Other" },
];

/**
 * When a radar change becomes an obligation, its category maps onto the
 * slice-1 obligation category set (see lib/legal/types.ts).
 */
export const RADAR_TO_OBLIGATION_CATEGORY: Record<
  RegulationChangeCategory,
  SeedObligationTemplate["category"]
> = {
  privacy: "filing",
  licensing: "license",
  tax: "tax",
  employment: "filing",
  insurance: "insurance",
  safety: "permit",
  other: "filing",
};

/** Prefix for obligation template keys created from radar changes. */
export const RADAR_OBLIGATION_KEY_PREFIX = "radar-";

/** Triage verdict: does this change touch the tenant's industry/jurisdictions? */
export type RadarRelevance = "relevant" | "not_relevant";

/** Tenant-controlled triage state. Absence of a row means "new". */
export type RadarTriageStatus = "reviewed" | "dismissed";

export const RADAR_TRIAGE_STATUSES: RadarTriageStatus[] = ["reviewed", "dismissed"];

/** One seed feed entry. Mirrors the RegulationChange model. */
export interface SeedRegulationChange {
  /** Stable slug, e.g. "nc-privacy-update". */
  key: string;
  title: string;
  /** Plain-English summary — informational only, never advice. */
  plainEnglishSummary: string;
  /** Empty = applies to all industries. */
  industries: string[];
  /** "national" = applies in every jurisdiction. */
  jurisdictions: string[];
  category: RegulationChangeCategory;
  /**
   * Only when the date itself was verified. Unverified changes keep this
   * null — never render a guessed effective date as fact.
   */
  effectiveDate: string | null;
  /** Source reference — never empty (guardrail: no invented specifics). */
  sourceRef: string;
  /** ISO timestamp the seed item was authored. */
  publishedAt: string;
  /** True for the illustrative v1 seed feed. */
  seedFlag: boolean;
}

/** The change record as read back from the DB (seed or future live feed). */
export interface RegulationChange extends SeedRegulationChange {
  id: string;
}

/**
 * A change with the tenant's triage verdict and triage state merged. The
 * engine works on the seed shape (no DB id); the store maps rows to it.
 */
export interface TriagedChange extends SeedRegulationChange {
  relevance: RadarRelevance;
  triage: "new" | RadarTriageStatus;
}

/**
 * The v1 seed feed is illustrative example content, NOT live regulatory
 * tracking. This notice must be visible wherever the radar renders (view +
 * API payload) so a tenant can never mistake v1 for a live feed.
 */
export const SEED_FEED_NOTICE =
  "Illustrative seed data — example entries to show how the radar works. " +
  "This is not a live regulatory feed and does not cover every rule change. " +
  "Always verify with the cited source before acting.";
