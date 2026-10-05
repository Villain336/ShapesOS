// ShapesOS — Phase 12 (people): the payroll tax-table contract.
//
// Tax tables are per-country PLUGINS (lib/ops/payroll/tax/index.ts is the
// registry). A table turns one payslip's wages into tax lines — employee
// withholdings and employer taxes — given the member's tax profile and
// year-to-date wage bases. PURE: no I/O, integer cents only.
//
// Every shipped table names its source and year. These are estimates for
// running payroll books, not tax advice: the UI and every payslip PDF carry
// a "verify with your accountant" banner (PAYROLL_TAX_DISCLAIMER).

export type FilingStatus = "single" | "married_jointly" | "head_of_household";
export const FILING_STATUSES: readonly FilingStatus[] = ["single", "married_jointly", "head_of_household"];

/** The 2020+ Form W-4 fields plus the work state. */
export interface TaxProfile {
  filingStatus: FilingStatus;
  /** W-4 Step 2 checkbox (multiple jobs / spouse works). */
  w4Step2: boolean;
  /** W-4 Step 3: annual dependents credit. */
  dependentsCreditCents: number;
  /** W-4 Step 4(a): annual other income. */
  otherIncomeCents: number;
  /** W-4 Step 4(b): annual deductions beyond the standard deduction. */
  deductionsCents: number;
  /** W-4 Step 4(c): extra withholding per pay period. */
  extraWithholdingCents: number;
  /** Two-letter work state (null = no state income tax withheld). */
  stateCode: string | null;
  /** Overrides the state table's flat rate (basis points). */
  stateRateBps: number | null;
}

/** Wage bases already used this calendar year (approved + posted pay runs). */
export interface YtdWages {
  ssWagesCents: number;
  medicareWagesCents: number;
  futaWagesCents: number;
}

export const ZERO_YTD: YtdWages = { ssWagesCents: 0, medicareWagesCents: 0, futaWagesCents: 0 };

export interface TaxInput {
  periodsPerYear: number;
  /** Wages subject to income-tax withholding this period (gross − pre-tax deductions). */
  incomeTaxWagesCents: number;
  /** Wages subject to Social Security / Medicare / FUTA this period. */
  ficaWagesCents: number;
  profile: TaxProfile;
  ytd: YtdWages;
  payDate: Date;
}

export type TaxParty = "employee" | "employer";

export interface TaxLine {
  /** Stable code, e.g. "us_fit", "us_ss_ee", "us_state_ca". */
  code: string;
  label: string;
  party: TaxParty;
  amountCents: number;
  /** The wage base the line was computed on (for the payslip). */
  wagesCents?: number;
  detail?: string;
}

export interface TaxResult {
  lines: TaxLine[];
  /** Wage bases consumed this period (they feed next period's YTD). */
  ssWagesCents: number;
  medicareWagesCents: number;
  futaWagesCents: number;
  warnings: string[];
  /** e.g. "us-federal-2026+us-state-flat-2026" (stored on the payslip). */
  tableId: string;
}

export interface PayrollTaxTable {
  id: string;
  country: string;
  year: number;
  label: string;
  /** Where the numbers come from (shown in the UI and the PDF). */
  source: string;
  compute(input: TaxInput): TaxResult;
}

export const PAYROLL_TAX_DISCLAIMER =
  "Tax amounts are estimates from the built-in tables. Verify them with your accountant or payroll provider before you pay anyone or file anything.";

/** amount × bps / 10 000, rounded half up — exact integer arithmetic. */
export function pctOf(amountCents: number, bps: number): number {
  if (amountCents <= 0 || bps <= 0) return 0;
  return Math.floor((amountCents * bps + 5_000) / 10_000);
}

/** Integer division of cents, rounded half up (non-negative inputs). */
export function divRound(cents: number, by: number): number {
  if (by <= 0) throw new Error("divide by a positive number");
  if (cents <= 0) return 0;
  return Math.floor((cents * 2 + by) / (2 * by));
}
