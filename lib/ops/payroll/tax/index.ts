// ShapesOS — Phase 12 (people): the payroll tax-table REGISTRY.
//
// Tax tables are pluggable per country: a country code maps to a factory
// that returns the PayrollTaxTable for a pay date. Shipped: "US" (federal
// 2026 + the flat-rate state table). Another country plugs in with
// registerPayrollTaxTable("GB", (payDate) => …) from its own module; a
// salary structure whose country has no table can't be computed (422) —
// payroll never silently withholds nothing.

import { OpsError } from "../../doctype";
import { computeUsFederal, US_FEDERAL_2026 } from "./us-federal";
import { computeStateFlat, US_STATE_FLAT_SOURCE, US_STATE_FLAT_YEAR } from "./us-state-flat";
import type { PayrollTaxTable, TaxInput, TaxResult } from "./types";

export * from "./types";

export type TaxTableFactory = (payDate: Date) => PayrollTaxTable;

const REGISTRY = new Map<string, TaxTableFactory>();

export function registerPayrollTaxTable(country: string, factory: TaxTableFactory): void {
  if (!/^[A-Z]{2}$/.test(country)) throw new Error("country must be an ISO 3166-1 alpha-2 code");
  REGISTRY.set(country, factory);
}

export function payrollTaxCountries(): string[] {
  return [...REGISTRY.keys()].sort();
}

export function payrollTaxTableFor(country: string, payDate: Date): PayrollTaxTable {
  const f = REGISTRY.get(country.toUpperCase());
  if (!f) {
    throw new OpsError(422, `No payroll tax table for "${country}". Shipped: ${payrollTaxCountries().join(", ")}.`);
  }
  return f(payDate);
}

/** The registered table a payslip was computed with (by its stored id), if still shipped. */
export function payrollTaxTableById(tableId: string, payDate: Date): PayrollTaxTable | null {
  for (const f of REGISTRY.values()) {
    const t = f(payDate);
    if (t.id === tableId) return t;
  }
  return null;
}

/** US: federal (Pub 15-T 2026, FICA, FUTA) + the flat-rate state table. */
export const US_PAYROLL_TAX_TABLE: PayrollTaxTable = {
  id: `us-federal-${US_FEDERAL_2026.year}+us-state-flat-${US_STATE_FLAT_YEAR}`,
  country: "US",
  year: US_FEDERAL_2026.year,
  label: `United States — federal ${US_FEDERAL_2026.year} and flat state rates`,
  source: `${US_FEDERAL_2026.source}. ${US_STATE_FLAT_SOURCE}.`,
  compute(input: TaxInput): TaxResult {
    const fed = computeUsFederal(input);
    const state = computeStateFlat(input.profile.stateCode, input.profile.stateRateBps, input.incomeTaxWagesCents);
    const lines = [...fed.lines];
    // State withholding sits with the other employee taxes (after federal FICA).
    if (state.line) lines.splice(lines.findIndex((l) => l.party === "employer"), 0, state.line);
    return {
      ...fed,
      lines,
      warnings: [...fed.warnings, ...(state.warning ? [state.warning] : [])],
      tableId: US_PAYROLL_TAX_TABLE.id,
    };
  },
};

registerPayrollTaxTable("US", () => US_PAYROLL_TAX_TABLE);
