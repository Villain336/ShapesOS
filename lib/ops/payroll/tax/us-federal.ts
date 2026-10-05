// ShapesOS — Phase 12 (people): US federal payroll taxes, tax year 2026.
//
// SOURCE YEAR 2026. Federal income-tax withholding follows IRS Publication
// 15-T, "Percentage Method Tables for Automated Payroll Systems and
// Withholding on Periodic Payments of Pensions and Annuities" — Worksheet 1A
// with the ANNUAL percentage-method tables, for Forms W-4 from 2020 or later:
//
//   1c  annual wages        = taxable wages this period × pay periods
//   1e  + W-4 step 4(a) other income
//   1h  − W-4 step 4(b) deductions − line 1g ($12,900 married filing
//       jointly / $8,600 otherwise when the step 2 box is NOT checked; 0
//       when it is)                                   = adjusted annual wage
//   2   tentative annual withholding from the table (STANDARD table, or the
//       "Form W-4, Step 2, Checkbox" table — half the brackets), ÷ periods
//   3   − W-4 step 3 credits ÷ periods (not below 0)
//   4   + W-4 step 4(c) extra withholding per period
//
// The tables are built from the 2026 standard deduction and brackets (IRS
// Rev. Proc. 2025-32, the 2026 inflation adjustments, after the 2025
// One Big Beautiful Bill Act made the 2017 rates permanent) exactly the way
// Pub 15-T lays them out: the first, 0% row of the STANDARD table runs to
// standard deduction − line 1g; the Step 2 table starts at half the standard
// deduction and halves every bracket. The checkbox table is kept in exact
// cents (the printed table rounds thresholds to whole dollars, which can move
// a result by a few cents). VERIFY against the published 2026 Pub 15-T
// before relying on these numbers.
//
// FICA (IRC §3101/§3111): Social Security 6.2% employee + 6.2% employer on
// wages up to the 2026 wage base of $184,500 (SSA, October 2025); Medicare
// 1.45% + 1.45% on all wages, plus the employee-only Additional Medicare Tax
// of 0.9% on wages above $200,000 in the calendar year (withholding
// threshold, regardless of filing status). FUTA (IRC §3301): 6.0% on the
// first $7,000 per employee less the 5.4% state credit = 0.6% net (credit-
// reduction states are NOT modelled). State unemployment (SUTA) varies by
// employer rate and is not computed.

import { FILING_STATUSES, divRound, pctOf, type FilingStatus, type TaxInput, type TaxLine, type TaxResult } from "./types";

export const US_FEDERAL_YEAR = 2026;

export const US_FEDERAL_2026 = {
  year: 2026,
  source:
    "IRS Pub 15-T (2026) Worksheet 1A, annual percentage method, built from Rev. Proc. 2025-32 (2026 brackets and standard deduction); SSA 2026 wage base; IRC §3101, §3111, §3301",
  /** 2026 standard deduction (cents). */
  standardDeductionCents: { single: 1_610_000, married_jointly: 3_220_000, head_of_household: 2_415_000 } satisfies Record<FilingStatus, number>,
  /** Worksheet 1A line 1g — subtracted when the W-4 step 2 box is NOT checked. */
  line1gCents: { single: 860_000, married_jointly: 1_290_000, head_of_household: 860_000 } satisfies Record<FilingStatus, number>,
  /** Taxable-income brackets: [upper bound in cents (null = no cap), rate in bps]. */
  brackets: {
    single: [[1_240_000, 1000], [5_040_000, 1200], [10_570_000, 2200], [20_177_500, 2400], [25_622_500, 3200], [64_060_000, 3500], [null, 3700]],
    married_jointly: [[2_480_000, 1000], [10_080_000, 1200], [21_140_000, 2200], [40_355_000, 2400], [51_245_000, 3200], [76_870_000, 3500], [null, 3700]],
    head_of_household: [[1_770_000, 1000], [6_745_000, 1200], [10_570_000, 2200], [20_175_000, 2400], [25_620_000, 3200], [64_060_000, 3500], [null, 3700]],
  } satisfies Record<FilingStatus, Array<[number | null, number]>>,
  socialSecurity: { rateBps: 620, wageBaseCents: 18_450_000 },
  medicare: { rateBps: 145, additionalRateBps: 90, additionalThresholdCents: 20_000_000 },
  futa: { netRateBps: 60, wageBaseCents: 700_000 },
} as const;

/** One row of an annual percentage-method table: wages over `overCents` are taxed at `rateBps`. */
export interface WithholdingRow {
  overCents: number;
  /** Upper bound (exclusive of the next row); null = no cap. */
  upToCents: number | null;
  rateBps: number;
}

/** The annual percentage-method table for a filing status (STANDARD or Step-2 checkbox). */
export function annualWithholdingTable(status: FilingStatus, step2: boolean): WithholdingRow[] {
  const t = US_FEDERAL_2026;
  const std = t.standardDeductionCents[status];
  const start = step2 ? std / 2 : std - t.line1gCents[status];
  const rows: WithholdingRow[] = [{ overCents: 0, upToCents: start, rateBps: 0 }];
  let lo = start;
  let prevBound = 0;
  for (const [bound, rate] of t.brackets[status]) {
    const width = bound === null ? null : step2 ? (bound - prevBound) / 2 : bound - prevBound;
    const hi = width === null ? null : lo + width;
    rows.push({ overCents: lo, upToCents: hi, rateBps: rate });
    if (hi === null) break;
    lo = hi;
    prevBound = bound!;
  }
  return rows;
}

/** Tentative annual withholding (cents) on an adjusted annual wage, from the table. */
export function tentativeAnnualWithholding(adjustedAnnualWageCents: number, status: FilingStatus, step2: boolean): number {
  if (adjustedAnnualWageCents <= 0) return 0;
  let scaled = 0; // cents × bps, exact
  for (const row of annualWithholdingTable(status, step2)) {
    if (adjustedAnnualWageCents <= row.overCents) break;
    const top = row.upToCents === null ? adjustedAnnualWageCents : Math.min(adjustedAnnualWageCents, row.upToCents);
    scaled += (top - row.overCents) * row.rateBps;
  }
  return Math.floor((scaled + 5_000) / 10_000);
}

export interface FitBreakdown {
  annualWagesCents: number;
  adjustedAnnualWageCents: number;
  tentativeAnnualCents: number;
  tentativePeriodCents: number;
  creditPeriodCents: number;
  extraCents: number;
  withholdingCents: number;
}

/** Federal income-tax withholding for one pay period (Pub 15-T Worksheet 1A). */
export function federalIncomeTaxWithholding(input: Pick<TaxInput, "periodsPerYear" | "incomeTaxWagesCents" | "profile">): FitBreakdown {
  const p = input.profile;
  if (!FILING_STATUSES.includes(p.filingStatus)) throw new Error(`Unknown filing status "${p.filingStatus}"`);
  const annual = Math.max(0, input.incomeTaxWagesCents) * input.periodsPerYear;
  const line1g = p.w4Step2 ? 0 : US_FEDERAL_2026.line1gCents[p.filingStatus];
  const adjusted = Math.max(0, annual + p.otherIncomeCents - p.deductionsCents - line1g);
  const tentativeAnnual = tentativeAnnualWithholding(adjusted, p.filingStatus, p.w4Step2);
  const tentativePeriod = divRound(tentativeAnnual, input.periodsPerYear);
  const credit = divRound(p.dependentsCreditCents, input.periodsPerYear);
  const extra = Math.max(0, p.extraWithholdingCents);
  return {
    annualWagesCents: annual,
    adjustedAnnualWageCents: adjusted,
    tentativeAnnualCents: tentativeAnnual,
    tentativePeriodCents: tentativePeriod,
    creditPeriodCents: credit,
    extraCents: extra,
    withholdingCents: Math.max(0, tentativePeriod - credit) + extra,
  };
}

/** Wages this period that still fall under a yearly cap. */
export function cappedWages(wagesCents: number, ytdCents: number, capCents: number): number {
  return Math.max(0, Math.min(Math.max(0, wagesCents), capCents - Math.max(0, ytdCents)));
}

/** Federal lines for one payslip: FIT, Social Security, Medicare (+ additional), FUTA. */
export function computeUsFederal(input: TaxInput): TaxResult {
  const t = US_FEDERAL_2026;
  const warnings: string[] = [];
  const year = input.payDate.getUTCFullYear();
  if (year !== t.year) warnings.push(`Pay date is in ${year}; the US federal table shipped is for ${t.year} — verify the amounts.`);
  const fit = federalIncomeTaxWithholding(input);
  const fica = Math.max(0, input.ficaWagesCents);
  const ss = cappedWages(fica, input.ytd.ssWagesCents, t.socialSecurity.wageBaseCents);
  const ssTax = pctOf(ss, t.socialSecurity.rateBps);
  const medicareTax = pctOf(fica, t.medicare.rateBps);
  // Additional Medicare: only the part of YTD + this period above $200,000.
  const overBefore = Math.max(0, input.ytd.medicareWagesCents - t.medicare.additionalThresholdCents);
  const overAfter = Math.max(0, input.ytd.medicareWagesCents + fica - t.medicare.additionalThresholdCents);
  const addlWages = overAfter - overBefore;
  const addlTax = pctOf(addlWages, t.medicare.additionalRateBps);
  const futa = cappedWages(fica, input.ytd.futaWagesCents, t.futa.wageBaseCents);
  const futaTax = pctOf(futa, t.futa.netRateBps);
  if (fica > 0 && ss < fica) warnings.push(`Social Security wage base ($${(t.socialSecurity.wageBaseCents / 100).toLocaleString("en-US")}) reached — only $${(ss / 100).toFixed(2)} of this period is taxed.`);

  const lines: TaxLine[] = [
    {
      code: "us_fit",
      label: "Federal income tax",
      party: "employee",
      amountCents: fit.withholdingCents,
      wagesCents: Math.max(0, input.incomeTaxWagesCents),
      detail: `Pub 15-T ${t.year} annual method, ${input.profile.filingStatus.replace(/_/g, " ")}${input.profile.w4Step2 ? ", step 2 checked" : ""}; adjusted annual wage $${(fit.adjustedAnnualWageCents / 100).toFixed(2)}`,
    },
    { code: "us_ss_ee", label: "Social Security", party: "employee", amountCents: ssTax, wagesCents: ss, detail: "6.2%" },
    { code: "us_medicare_ee", label: "Medicare", party: "employee", amountCents: medicareTax, wagesCents: fica, detail: "1.45%" },
    ...(addlTax > 0
      ? [{ code: "us_medicare_addl", label: "Additional Medicare", party: "employee" as const, amountCents: addlTax, wagesCents: addlWages, detail: "0.9% over $200,000 in the year" }]
      : []),
    { code: "us_ss_er", label: "Social Security (employer)", party: "employer", amountCents: ssTax, wagesCents: ss, detail: "6.2%" },
    { code: "us_medicare_er", label: "Medicare (employer)", party: "employer", amountCents: medicareTax, wagesCents: fica, detail: "1.45%" },
    { code: "us_futa", label: "Federal unemployment (FUTA)", party: "employer", amountCents: futaTax, wagesCents: futa, detail: "0.6% net of the state credit, first $7,000" },
  ];
  return { lines, ssWagesCents: ss, medicareWagesCents: fica, futaWagesCents: futa, warnings, tableId: `us-federal-${t.year}` };
}
