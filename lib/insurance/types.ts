// Marketr — Wave 2 Insurance slice 1: policy inventory domain (pure).
//
// Insurance is a money red-lane domain (SPEC-INSURANCE.md §4.4): premiums are
// consequential payments, the OS never holds premium funds, and coverage data
// renders ONLY from vendor/carrier truth — the parser below extracts what it
// finds and leaves the rest null ("not confirmed"), never a guess.
//
// This file is pure (no Prisma, no I/O) so every rule is unit-testable without
// a database.

export type InsuranceLineOfBusiness =
  | "gl"
  | "wc"
  | "bop"
  | "cyber"
  | "professional_liability"
  | "commercial_auto"
  | "umbrella";

export type InsurancePolicyStatus =
  | "active"
  | "pending_renewal"
  | "expired"
  | "cancelled";

export type InsuranceAppointmentPath =
  | "direct"
  | "dais_market_access"
  | "subappointment";

export type InsuranceRemarketStatus =
  | "detected"
  | "remarketing"
  | "quoted"
  | "bound"
  | "auto_renew_surfaced";

export class InsuranceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "InsuranceError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Policy status machine.
// active → pending_renewal → active (renewed) | expired | cancelled.
// active → expired | cancelled. Nothing leaves expired or cancelled.
// ---------------------------------------------------------------------------

const POLICY_TRANSITIONS: Record<InsurancePolicyStatus, InsurancePolicyStatus[]> = {
  active: ["pending_renewal", "expired", "cancelled"],
  pending_renewal: ["active", "expired", "cancelled"],
  expired: [],
  cancelled: [],
};

export function isValidPolicyStatusTransition(
  from: InsurancePolicyStatus,
  to: InsurancePolicyStatus,
): boolean {
  return POLICY_TRANSITIONS[from].includes(to);
}

export function assertPolicyStatusTransition(
  from: InsurancePolicyStatus,
  to: InsurancePolicyStatus,
): void {
  if (!isValidPolicyStatusTransition(from, to)) {
    throw new InsuranceError(
      "INVALID_STATUS_TRANSITION",
      `Cannot move insurance policy from ${from} to ${to}.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Renewal remarket machine.
// detected → remarketing → quoted → bound. detected → auto_renew_surfaced
// (surfaced, never silently accepted). bound and auto_renew_surfaced are
// terminal for a renewal row; the next term creates a fresh row.
// ---------------------------------------------------------------------------

const REMARKET_TRANSITIONS: Record<InsuranceRemarketStatus, InsuranceRemarketStatus[]> = {
  detected: ["remarketing", "auto_renew_surfaced"],
  remarketing: ["quoted", "detected"],
  quoted: ["bound", "remarketing"],
  bound: [],
  auto_renew_surfaced: [],
};

export function isValidRemarketTransition(
  from: InsuranceRemarketStatus,
  to: InsuranceRemarketStatus,
): boolean {
  return REMARKET_TRANSITIONS[from].includes(to);
}

export function assertRemarketTransition(
  from: InsuranceRemarketStatus,
  to: InsuranceRemarketStatus,
): void {
  if (!isValidRemarketTransition(from, to)) {
    throw new InsuranceError(
      "INVALID_REMARKET_TRANSITION",
      `Cannot move renewal from ${from} to ${to}.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Policy validation. Fail closed: a policy row is only valid coverage truth
// when it names the policy, the carrier, the line, and a sane term window.
// Limits/premiums may be null ("not confirmed") — the parser must never
// invent them.
// ---------------------------------------------------------------------------

export interface PolicyInput {
  policyNumber: string;
  carrierId: string;
  line: InsuranceLineOfBusiness;
  namedInsured: string;
  effectiveAt: Date;
  expiresAt: Date;
  limitPerOccurrenceCents?: number | null;
  limitAggregateCents?: number | null;
  deductibleCents?: number | null;
  annualPremiumCents?: number | null;
}

export function validatePolicyInput(input: PolicyInput): void {
  if (!input.policyNumber || input.policyNumber.trim().length === 0) {
    throw new InsuranceError("POLICY_NUMBER_REQUIRED", "Policy number is required.");
  }
  if (!input.carrierId) {
    throw new InsuranceError("CARRIER_REQUIRED", "A policy must reference a carrier.");
  }
  if (!input.namedInsured || input.namedInsured.trim().length === 0) {
    throw new InsuranceError("NAMED_INSURED_REQUIRED", "Named insured is required.");
  }
  if (!(input.effectiveAt instanceof Date) || Number.isNaN(input.effectiveAt.getTime())) {
    throw new InsuranceError("BAD_EFFECTIVE_DATE", "Effective date must be a valid date.");
  }
  if (!(input.expiresAt instanceof Date) || Number.isNaN(input.expiresAt.getTime())) {
    throw new InsuranceError("BAD_EXPIRY_DATE", "Expiry date must be a valid date.");
  }
  if (input.expiresAt <= input.effectiveAt) {
    throw new InsuranceError(
      "INVERTED_TERM",
      "Expiry date must be after the effective date.",
    );
  }
  for (const [label, v] of [
    ["limitPerOccurrenceCents", input.limitPerOccurrenceCents],
    ["limitAggregateCents", input.limitAggregateCents],
    ["deductibleCents", input.deductibleCents],
    ["annualPremiumCents", input.annualPremiumCents],
  ] as const) {
    if (v != null && (!Number.isInteger(v) || v < 0)) {
      throw new InsuranceError("BAD_MONEY_VALUE", `${label} must be a non-negative integer in cents.`);
    }
  }
}

// ---------------------------------------------------------------------------
// Renewal alerts. Alert levels by days until expiry; the OS surfaces renewals,
// never silently accepts auto-renewals.
// ---------------------------------------------------------------------------

export type RenewalAlertLevel = "none" | "info" | "warning" | "critical";

export const RENEWAL_ALERT_WINDOWS = {
  critical: 30,
  warning: 60,
  info: 90,
} as const;

export function daysUntilRenewal(expiresAt: Date, now: Date = new Date()): number {
  const ms = expiresAt.getTime() - now.getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

export function renewalAlertLevel(
  expiresAt: Date,
  now: Date = new Date(),
): RenewalAlertLevel {
  const days = daysUntilRenewal(expiresAt, now);
  if (days > RENEWAL_ALERT_WINDOWS.info) return "none";
  if (days > RENEWAL_ALERT_WINDOWS.warning) return "info";
  if (days > RENEWAL_ALERT_WINDOWS.critical) return "warning";
  return "critical";
}

// ---------------------------------------------------------------------------
// Premium delta. (new - prior) / prior * 100. The agent flags deltas above the
// threshold before asking for renewal approval (SPEC-INSURANCE.md §4.3).
// ---------------------------------------------------------------------------

export const DEFAULT_DELTA_FLAG_THRESHOLD_PCT = 10;

export function premiumDeltaPct(
  priorPremiumCents: number,
  newPremiumCents: number,
): number {
  if (priorPremiumCents <= 0) {
    throw new InsuranceError(
      "BAD_PRIOR_PREMIUM",
      "Prior premium must be positive to compute a delta.",
    );
  }
  return ((newPremiumCents - priorPremiumCents) / priorPremiumCents) * 100;
}

export function deltaExceedsThreshold(
  priorPremiumCents: number,
  newPremiumCents: number,
  thresholdPct: number = DEFAULT_DELTA_FLAG_THRESHOLD_PCT,
): boolean {
  return Math.abs(premiumDeltaPct(priorPremiumCents, newPremiumCents)) > thresholdPct;
}

// ---------------------------------------------------------------------------
// Declarations-page parsing. Extracts what it can find from raw declarations
// text (pasted or OCR'd); anything not found stays null — "not confirmed",
// never invented. Returns parse confidence so the UI can route low-confidence
// rows to human review.
// ---------------------------------------------------------------------------

export interface ParsedDeclarations {
  policyNumber: string | null;
  carrierName: string | null;
  namedInsured: string | null;
  line: InsuranceLineOfBusiness | null;
  effectiveAt: Date | null;
  expiresAt: Date | null;
  limitPerOccurrenceCents: number | null;
  limitAggregateCents: number | null;
  deductibleCents: number | null;
  annualPremiumCents: number | null;
  /** 0–1: fraction of core fields found (policy number, dates, carrier). */
  confidence: number;
}

const LINE_HINTS: Array<[RegExp, InsuranceLineOfBusiness]> = [
  [/general\s+liability/i, "gl"],
  [/workers[’']?\s*comp/i, "wc"],
  [/business\s+owners?\s+policy|\bBOP\b/i, "bop"],
  [/cyber/i, "cyber"],
  [/professional\s+liability|errors?\s*&?\s*omissions|\bE&O\b/i, "professional_liability"],
  [/commercial\s+auto/i, "commercial_auto"],
  [/umbrella/i, "umbrella"],
];

const CARRIER_HINTS = [
  "AmTrust",
  "Chubb",
  "Liberty Mutual",
  "Travelers",
  "Hartford",
  "CNA",
  "Zurich",
  "AIG",
];

function moneyToCents(raw: string): number | null {
  const n = Number(raw.replace(/[$,\s]/g, ""));
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

function parseDateLoose(raw: string): Date | null {
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function parseDeclarationsText(text: string): ParsedDeclarations {
  const out: ParsedDeclarations = {
    policyNumber: null,
    carrierName: null,
    namedInsured: null,
    line: null,
    effectiveAt: null,
    expiresAt: null,
    limitPerOccurrenceCents: null,
    limitAggregateCents: null,
    deductibleCents: null,
    annualPremiumCents: null,
    confidence: 0,
  };
  if (!text || text.trim().length === 0) return out;

  const policyMatch = text.match(
    /policy\s*(?:number|no\.?|#)\s*[:#-]?\s*([A-Z0-9][A-Z0-9\-./]{3,})/i,
  );
  if (policyMatch) out.policyNumber = policyMatch[1]!.trim();

  for (const carrier of CARRIER_HINTS) {
    if (new RegExp(carrier.replace(/\s+/g, "\\s+"), "i").test(text)) {
      out.carrierName = carrier;
      break;
    }
  }

  const insuredMatch = text.match(/named\s+insured\s*[:\-]?\s*([^\n]{2,80})/i);
  if (insuredMatch) out.namedInsured = insuredMatch[1]!.trim();

  for (const [re, line] of LINE_HINTS) {
    if (re.test(text)) {
      out.line = line;
      break;
    }
  }

  const effectiveMatch = text.match(
    /effective\s*(?:date)?\s*[:\-]?\s*([A-Z][a-z]{2,8}\s+\d{1,2},?\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4})/i,
  );
  if (effectiveMatch) out.effectiveAt = parseDateLoose(effectiveMatch[1]!);

  const expiryMatch = text.match(
    /(?:expir(?:y|ation)|expires?)\s*(?:date)?\s*[:\-]?\s*([A-Z][a-z]{2,8}\s+\d{1,2},?\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4})/i,
  );
  if (expiryMatch) out.expiresAt = parseDateLoose(expiryMatch[1]!);

  const perOccMatch = text.match(
    /(?:per|each)\s+occurrence(?:\s+limit)?\s*[:\-]?\s*\$?([\d,]+(?:\.\d{2})?)/i,
  );
  if (perOccMatch) out.limitPerOccurrenceCents = moneyToCents(perOccMatch[1]!);

  const aggMatch = text.match(
    /(?:general\s+)?aggregate\s*(?:limit)?\s*[:\-]?\s*\$?([\d,]+(?:\.\d{2})?)/i,
  );
  if (aggMatch) out.limitAggregateCents = moneyToCents(aggMatch[1]!);

  const dedMatch = text.match(/deductible\s*[:\-]?\s*\$?([\d,]+(?:\.\d{2})?)/i);
  if (dedMatch) out.deductibleCents = moneyToCents(dedMatch[1]!);

  const premMatch = text.match(
    /(?:annual|total)\s+premium\s*[:\-]?\s*\$?([\d,]+(?:\.\d{2})?)/i,
  );
  if (premMatch) out.annualPremiumCents = moneyToCents(premMatch[1]!);

  // Confidence = fraction of the core identity fields found.
  const core = [
    out.policyNumber,
    out.carrierName,
    out.namedInsured,
    out.effectiveAt,
    out.expiresAt,
  ];
  const found = core.filter((v) => v !== null).length;
  out.confidence = found / core.length;

  return out;
}

/** Low-confidence parses must be reviewed by a human before becoming policy truth. */
export const DECLARATIONS_REVIEW_THRESHOLD = 0.6;

export function declarationsNeedReview(parsed: ParsedDeclarations): boolean {
  return parsed.confidence < DECLARATIONS_REVIEW_THRESHOLD;
}

// ---------------------------------------------------------------------------
// Line-of-business labels for UI.
// ---------------------------------------------------------------------------

export const LINE_LABELS: Record<InsuranceLineOfBusiness, string> = {
  gl: "General Liability",
  wc: "Workers' Comp",
  bop: "Business Owner's Policy",
  cyber: "Cyber",
  professional_liability: "Professional Liability",
  commercial_auto: "Commercial Auto",
  umbrella: "Umbrella",
};
