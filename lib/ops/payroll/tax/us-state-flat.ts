// ShapesOS — Phase 12 (people): a FLAT-RATE state income-tax table.
//
// SOURCE YEAR 2026 (rates as enacted by the end of 2025 for tax year 2026;
// several states cut their flat rate every January — VERIFY each one with
// the state's 2026 withholding guide). Withholding = this period's
// income-tax wages × the state's flat rate. State allowances, exemptions,
// local/city taxes, SDI/PFML and SUTA are NOT modelled.
//
//   * States without a wage income tax withhold nothing.
//   * Flat-tax states use the rate below.
//   * Graduated-rate states (CA, NY, NJ, OR, MN, …) have no single rate:
//     nothing is withheld until a rate is set on the member's salary
//     assignment (stateRateBps), and the payslip says so.
// A rate on the assignment always overrides this table.

import { pctOf, type TaxLine } from "./types";

export const US_STATE_FLAT_YEAR = 2026;

export const US_STATE_FLAT_SOURCE =
  "Flat state income-tax rates for tax year 2026 as enacted by the end of 2025 (state revenue department withholding guides) — no allowances or local taxes";

/** No state income tax on wages. */
export const NO_WAGE_TAX_STATES: ReadonlySet<string> = new Set(["AK", "FL", "NV", "NH", "SD", "TN", "TX", "WA", "WY"]);

/** Flat rate (basis points) for states with a single-rate wage income tax. */
export const FLAT_STATE_RATES_BPS: Readonly<Record<string, number>> = {
  AZ: 250, // Arizona 2.5%
  CO: 440, // Colorado 4.4%
  GA: 509, // Georgia 5.09% (HB 111 step-down: 5.19% in 2025)
  ID: 530, // Idaho 5.3%
  IL: 495, // Illinois 4.95%
  IN: 295, // Indiana 2.95% (state rate only; county taxes not included)
  IA: 380, // Iowa 3.8%
  KY: 350, // Kentucky 3.5%
  LA: 300, // Louisiana 3.0%
  MA: 500, // Massachusetts 5.0% (the 4% surtax over $1M is not modelled)
  MI: 425, // Michigan 4.25% (city taxes not included)
  MS: 400, // Mississippi 4.0% (first $10,000 exempt — not modelled)
  NC: 399, // North Carolina 3.99%
  PA: 307, // Pennsylvania 3.07% (local EIT not included)
  UT: 450, // Utah 4.5%
};

export const US_STATE_CODES: readonly string[] = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME",
  "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI",
  "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
];

export interface StateTaxOutcome {
  line: TaxLine | null;
  warning: string | null;
  rateBps: number | null;
}

/** State income-tax withholding for one period (flat rate; override wins). */
export function computeStateFlat(stateCode: string | null, overrideBps: number | null, incomeTaxWagesCents: number): StateTaxOutcome {
  if (!stateCode) return { line: null, warning: null, rateBps: null };
  const code = stateCode.toUpperCase();
  if (!US_STATE_CODES.includes(code)) return { line: null, warning: `Unknown state "${stateCode}" — no state tax withheld.`, rateBps: null };
  let rate: number | null = overrideBps ?? null;
  let how = "rate set on the assignment";
  if (rate === null) {
    if (NO_WAGE_TAX_STATES.has(code)) return { line: null, warning: null, rateBps: 0 };
    const flat = FLAT_STATE_RATES_BPS[code];
    if (flat === undefined) {
      return {
        line: null,
        warning: `${code} has graduated income-tax rates — nothing withheld. Set a state rate on this person's salary assignment.`,
        rateBps: null,
      };
    }
    rate = flat;
    how = `${US_STATE_FLAT_YEAR} flat rate`;
  }
  const amount = pctOf(Math.max(0, incomeTaxWagesCents), rate);
  return {
    line: {
      code: `us_state_${code.toLowerCase()}`,
      label: `${code} state income tax`,
      party: "employee",
      amountCents: amount,
      wagesCents: Math.max(0, incomeTaxWagesCents),
      detail: `${(rate / 100).toFixed(2)}% (${how})`,
    },
    warning: null,
    rateBps: rate,
  };
}
