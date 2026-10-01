// Marketr — Wave 2 Insurance slice 2: quoting domain (pure).
//
// Submission intake validation, the quote status machine, and cross-carrier
// quote normalization. Declines and referrals are first-class outcomes with
// documented reasons — they are never dropped from comparisons; the agent
// explains them in plain language (SPEC-INSURANCE.md §4.5).

import { InsuranceError, type InsuranceLineOfBusiness } from "./types";

export type InsuranceSubmissionStatus =
  | "draft"
  | "submitted"
  | "quoted"
  | "declined"
  | "expired";

export type InsuranceQuoteStatus =
  | "draft"
  | "quoted"
  | "declined"
  | "referred"
  | "expired"
  | "bound";

// ---------------------------------------------------------------------------
// Quote status machine. draft → quoted | declined | referred. quoted may move
// to bound (slice 3, behind the approval + license-model gates) or expired.
// declined / referred / expired / bound are terminal.
// ---------------------------------------------------------------------------

const QUOTE_TRANSITIONS: Record<InsuranceQuoteStatus, InsuranceQuoteStatus[]> = {
  draft: ["quoted", "declined", "referred"],
  quoted: ["bound", "expired"],
  declined: [],
  referred: [],
  expired: [],
  bound: [],
};

export function isValidQuoteTransition(
  from: InsuranceQuoteStatus,
  to: InsuranceQuoteStatus,
): boolean {
  return QUOTE_TRANSITIONS[from].includes(to);
}

export function assertQuoteTransition(
  from: InsuranceQuoteStatus,
  to: InsuranceQuoteStatus,
): void {
  if (!isValidQuoteTransition(from, to)) {
    throw new InsuranceError(
      "INVALID_QUOTE_TRANSITION",
      `Cannot move insurance quote from ${from} to ${to}.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Submission intake validation. Fail closed: submitting a risk to carriers
// discloses business data, so the intake must be complete and explicit.
// ---------------------------------------------------------------------------

export interface LossHistoryEntry {
  year: number;
  claimCount: number;
  totalCents: number;
}

export interface SubmissionIntake {
  line: InsuranceLineOfBusiness;
  applicantName: string;
  operationsDescription?: string;
  state: string;
  classCode?: string;
  payrollCents?: number | null;
  revenueCents?: number | null;
  targetLimitPerOccurrenceCents?: number | null;
  targetLimitAggregateCents?: number | null;
  lossHistory?: LossHistoryEntry[];
}

export function validateSubmissionIntake(input: SubmissionIntake): void {
  if (!input.applicantName || input.applicantName.trim().length === 0) {
    throw new InsuranceError("APPLICANT_REQUIRED", "Applicant name is required.");
  }
  if (!/^[A-Z]{2}$/.test(input.state.trim().toUpperCase())) {
    throw new InsuranceError(
      "BAD_STATE",
      "State must be a 2-letter US state code (e.g. NC).",
    );
  }
  for (const [label, v] of [
    ["payrollCents", input.payrollCents],
    ["revenueCents", input.revenueCents],
    ["targetLimitPerOccurrenceCents", input.targetLimitPerOccurrenceCents],
    ["targetLimitAggregateCents", input.targetLimitAggregateCents],
  ] as const) {
    if (v != null && (!Number.isInteger(v) || v < 0)) {
      throw new InsuranceError(
        "BAD_MONEY_VALUE",
        `${label} must be a non-negative integer in cents.`,
      );
    }
  }
  if (input.lossHistory) {
    for (const entry of input.lossHistory) {
      if (
        !Number.isInteger(entry.year) ||
        entry.year < 1900 ||
        entry.year > new Date().getFullYear()
      ) {
        throw new InsuranceError("BAD_LOSS_YEAR", "Loss history years must be real years.");
      }
      if (!Number.isInteger(entry.claimCount) || entry.claimCount < 0) {
        throw new InsuranceError("BAD_LOSS_COUNT", "Claim counts must be non-negative integers.");
      }
      if (!Number.isInteger(entry.totalCents) || entry.totalCents < 0) {
        throw new InsuranceError("BAD_LOSS_TOTAL", "Loss totals must be non-negative cents.");
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Quote normalization. Carriers quote different limit structures; normalize to
// a comparable row so the comparison UI ranks apples-to-apples. The metric is
// premium per $1M of aggregate limit — null when either side is missing, never
// a guess.
// ---------------------------------------------------------------------------

export interface RawVendorQuote {
  carrierName: string;
  quotedPremiumCents: number | null;
  limitPerOccurrenceCents: number | null;
  limitAggregateCents: number | null;
  quoteExpiry: string;
  status: "quoted" | "declined" | "referred";
  declineReason?: string;
}

export interface NormalizedQuote extends RawVendorQuote {
  /** Premium per $1M of aggregate limit, in cents. Null when not computable. */
  premiumPerMillionAggregateCents: number | null;
  /** 1-based rank among quoted offers by premium (cheapest = 1). Null if not quoted. */
  rank: number | null;
}

export function normalizeQuotes(quotes: RawVendorQuote[]): NormalizedQuote[] {
  const normalized: NormalizedQuote[] = quotes.map((q) => {
    let premiumPerMillionAggregateCents: number | null = null;
    if (
      q.status === "quoted" &&
      q.quotedPremiumCents != null &&
      q.limitAggregateCents != null &&
      q.limitAggregateCents > 0
    ) {
      premiumPerMillionAggregateCents = Math.round(
        (q.quotedPremiumCents / q.limitAggregateCents) * 100_000_000,
      );
    }
    return { ...q, premiumPerMillionAggregateCents, rank: null };
  });
  const quotable = normalized
    .filter((q) => q.status === "quoted" && q.quotedPremiumCents != null)
    .sort((a, b) => a.quotedPremiumCents! - b.quotedPremiumCents!);
  quotable.forEach((q, i) => {
    q.rank = i + 1;
  });
  return normalized;
}

/** Derive the submission-level status from its quotes. */
export function deriveSubmissionStatus(
  quoteStatuses: InsuranceQuoteStatus[],
): InsuranceSubmissionStatus {
  if (quoteStatuses.length === 0) return "submitted";
  if (quoteStatuses.some((s) => s === "quoted" || s === "bound")) return "quoted";
  if (quoteStatuses.every((s) => s === "declined")) return "declined";
  if (quoteStatuses.every((s) => s === "expired")) return "expired";
  return "submitted";
}
