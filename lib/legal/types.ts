// Marketr — Legal/Compliance slice 1: Obligation map domain types.
// Spec: BUSINESS-OS-FEATURE-SPECS.md §4 (Launch pillar: stay legal).
//
// Hard guardrails (never bend):
// 1. Information, NEVER legal advice — LEGAL_DISCLAIMER ships on every
//    output (page, API response, seed copy).
// 2. Never invent specifics — templates carry a source reference; anything
//    unverified is flagged needsReview instead of rendered as fact.
// 3. Insurance invariant — "Licensed partner: they hold the licenses, we
//    provide the software." Slice 1 lists insurance obligations but NEVER
//    presents a binding path.

/** Every legal output carries this label. Never remove or soften it. */
export const LEGAL_DISCLAIMER =
  "This is general information only — not legal advice. Rules change and vary " +
  "by situation. Talk to a licensed attorney before acting on anything here.";

export type ObligationCategory =
  | "license"
  | "filing"
  | "tax"
  | "insurance"
  | "permit";

export const OBLIGATION_CATEGORIES: { value: ObligationCategory; label: string }[] = [
  { value: "license", label: "Licenses" },
  { value: "filing", label: "Filings" },
  { value: "tax", label: "Tax registrations" },
  { value: "insurance", label: "Insurance" },
  { value: "permit", label: "Permits" },
];

export type ObligationStatus = "open" | "snoozed" | "dismissed" | "done";

/** Seed coverage industries (spec's named four). New industry = data addition. */
export const INDUSTRIES = [
  { value: "food", label: "Food & beverage" },
  { value: "drones", label: "Drones" },
  { value: "saas", label: "SaaS / software" },
  { value: "services", label: "Services" },
] as const;

export type Industry = (typeof INDUSTRIES)[number]["value"];

/** Seed coverage jurisdictions. "national" templates apply everywhere. */
export const JURISDICTIONS = [
  { value: "NC", label: "North Carolina" },
] as const;

export type Jurisdiction = (typeof JURISDICTIONS)[number]["value"];

/** "national" is the only reserved jurisdiction value in seed data. */
export const NATIONAL_JURISDICTION = "national";

export const BUSINESS_MODELS = [
  { value: "sole_proprietor", label: "Sole proprietorship" },
  { value: "llc", label: "LLC" },
  { value: "corporation", label: "Corporation" },
  { value: "partnership", label: "Partnership" },
] as const;

export type BusinessModel = (typeof BUSINESS_MODELS)[number]["value"];

export interface LegalProfileInput {
  industry: string;
  businessModel: string;
  jurisdictions: string[];
}

export class LegalError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(`[${code}] ${message}`);
    this.code = code;
  }
}

export function validateLegalProfileInput(input: LegalProfileInput): void {
  if (!INDUSTRIES.some((i) => i.value === input.industry)) {
    throw new LegalError(
      "INVALID_INDUSTRY",
      `Industry must be one of: ${INDUSTRIES.map((i) => i.value).join(", ")}`,
    );
  }
  if (!BUSINESS_MODELS.some((b) => b.value === input.businessModel)) {
    throw new LegalError(
      "INVALID_BUSINESS_MODEL",
      `Business model must be one of: ${BUSINESS_MODELS.map((b) => b.value).join(", ")}`,
    );
  }
  if (!Array.isArray(input.jurisdictions) || input.jurisdictions.length === 0) {
    throw new LegalError(
      "INVALID_JURISDICTIONS",
      "Pick at least one jurisdiction.",
    );
  }
  const unknown = input.jurisdictions.filter(
    (j) => !JURISDICTIONS.some((known) => known.value === j),
  );
  if (unknown.length > 0) {
    throw new LegalError(
      "INVALID_JURISDICTIONS",
      `Unknown jurisdiction(s): ${unknown.join(", ")}`,
    );
  }
  if (new Set(input.jurisdictions).size !== input.jurisdictions.length) {
    throw new LegalError("INVALID_JURISDICTIONS", "Duplicate jurisdictions.");
  }
}

/** Shape of a seed obligation template (mirrors ObligationTemplate). */
export interface SeedObligationTemplate {
  key: string;
  /** Empty = applies to all industries. */
  industries: string[];
  /** "national" = applies in every jurisdiction. */
  jurisdictions: string[];
  category: ObligationCategory;
  title: string;
  description: string;
  /** Source reference — never empty (guardrail: no invented specifics). */
  sourceRef: string;
  /** Plain-words renewal cadence; null when unknown rather than invented. */
  renewalCadence: string | null;
  /** True when specifics were deliberately left out for verification. */
  needsReview: boolean;
}

export interface ComputedObligation extends SeedObligationTemplate {
  status: ObligationStatus;
  snoozedUntil: string | null;
  note: string | null;
}
