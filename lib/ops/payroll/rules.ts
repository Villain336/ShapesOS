// ShapesOS — Phase 12 (people): the payroll rules engine. PURE (no I/O):
// every rule is unit-tested on its own (lib/ops/__tests__/p12-payroll.test.ts).
//
// A salary structure is a small rules engine:
//   base       "salary": the annual salary ÷ pay periods, prorated by
//              calendar days when the assignment starts or ends inside the
//              period; "hourly": APPROVED timesheet minutes × the rate.
//   overtime   hourly only: minutes past the weekly threshold (default
//              2 400 = 40 h) in a workweek (Monday 00:00 UTC) are paid at the
//              multiplier (default 1.5×). Salaried pay is treated as exempt.
//   components allowances (taxable earnings), pre-tax deductions (reduce
//              income-tax wages; "reducesFicaWages" for Section 125-style
//              plans), post-tax deductions, employer contributions — each a
//              fixed amount per period or a percentage of base pay (for
//              allowances) / gross pay (for everything else).
//   taxes      the country's pluggable tax table (lib/ops/payroll/tax).
//
//   gross    = base + overtime + allowances
//   taxable  = gross − pre-tax deductions               (income-tax wages)
//   net      = gross − pre-tax − employee taxes − post-tax deductions
// Deductions never push net below zero: they are capped, with a warning.
// Money is integer cents; percentages are basis points, rounded half up.

import { OpsError } from "../doctype";
import { pctOf, type PayrollTaxTable, type TaxProfile, type YtdWages } from "./tax";

export type PayType = "salary" | "hourly";
export type PayFrequency = "weekly" | "biweekly" | "semimonthly" | "monthly";

export const PAY_TYPES: readonly PayType[] = ["salary", "hourly"];
export const PAY_FREQUENCIES: readonly PayFrequency[] = ["weekly", "biweekly", "semimonthly", "monthly"];

export const PERIODS_PER_YEAR: Readonly<Record<PayFrequency, number>> = {
  weekly: 52,
  biweekly: 26,
  semimonthly: 24,
  monthly: 12,
};

export type ComponentKind = "allowance" | "pre_tax_deduction" | "post_tax_deduction" | "employer_contribution";
export const COMPONENT_KINDS: readonly ComponentKind[] = ["allowance", "pre_tax_deduction", "post_tax_deduction", "employer_contribution"];

export interface PayComponent {
  /** Short stable code, e.g. "401k", "health", "phone". */
  code: string;
  label: string;
  kind: ComponentKind;
  calc: "fixed" | "percent";
  /** calc "fixed": cents per pay period. */
  amountCents?: number;
  /** calc "percent": basis points (500 = 5%). */
  rateBps?: number;
  /** Pre-tax only: also exempt from Social Security / Medicare / FUTA (Section 125 plans). */
  reducesFicaWages?: boolean;
}

const CODE_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const MAX_CENTS = 2_147_483_647;

/** Validate untrusted structure components (400 with the first problem). */
export function parseComponents(raw: unknown): PayComponent[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new OpsError(400, "components must be a list");
  if (raw.length > 30) throw new OpsError(400, "A structure can have at most 30 components");
  const seen = new Set<string>();
  return raw.map((v, i) => {
    const c = (v ?? {}) as Record<string, unknown>;
    const at = `Component ${i + 1}`;
    const code = typeof c.code === "string" ? c.code.trim().toLowerCase() : "";
    if (!CODE_RE.test(code)) throw new OpsError(400, `${at}: code must be 1–32 lowercase letters, digits, - or _`);
    if (seen.has(code)) throw new OpsError(400, `${at}: duplicate code "${code}"`);
    seen.add(code);
    const label = typeof c.label === "string" && c.label.trim() ? c.label.trim().slice(0, 80) : code;
    const kind = c.kind as ComponentKind;
    if (!COMPONENT_KINDS.includes(kind)) throw new OpsError(400, `${at}: kind must be one of ${COMPONENT_KINDS.join(", ")}`);
    const calc = c.calc === "percent" ? "percent" : c.calc === "fixed" || c.calc === undefined ? "fixed" : null;
    if (!calc) throw new OpsError(400, `${at}: calc must be "fixed" or "percent"`);
    const out: PayComponent = { code, label, kind, calc };
    if (calc === "fixed") {
      const a = c.amountCents;
      if (typeof a !== "number" || !Number.isInteger(a) || a < 0 || a > MAX_CENTS) throw new OpsError(400, `${at}: amountCents must be whole cents ≥ 0`);
      out.amountCents = a;
    } else {
      const r = c.rateBps;
      if (typeof r !== "number" || !Number.isInteger(r) || r < 0 || r > 10_000) throw new OpsError(400, `${at}: rateBps must be 0–10 000`);
      out.rateBps = r;
    }
    if (c.reducesFicaWages === true) {
      if (kind !== "pre_tax_deduction") throw new OpsError(400, `${at}: only a pre-tax deduction can reduce FICA wages`);
      out.reducesFicaWages = true;
    }
    return out;
  });
}

// ---------------------------------------------------------------------------
// Dates (pay periods are whole UTC days, inclusive)
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

export function utcDay(d: Date): number {
  return Math.floor(d.getTime() / DAY_MS);
}

/** Inclusive day count of [start, end]. */
export function daysInclusive(start: Date, end: Date): number {
  return Math.max(0, utcDay(end) - utcDay(start) + 1);
}

/** Days of [start, end] covered by [from, to] (to null = open). */
export function coveredDays(start: Date, end: Date, from: Date, to: Date | null): number {
  const s = Math.max(utcDay(start), utcDay(from));
  const e = Math.min(utcDay(end), to ? utcDay(to) : Number.POSITIVE_INFINITY);
  return Math.max(0, e - s + 1);
}

/** Monday (UTC) of the workweek containing d, as a day number. */
export function workweekOf(d: Date): number {
  const day = utcDay(d);
  const dow = (new Date(day * DAY_MS).getUTCDay() + 6) % 7; // Monday = 0
  return day - dow;
}

// ---------------------------------------------------------------------------
// Overtime
// ---------------------------------------------------------------------------

export interface TimeEntryLike {
  minutes: number;
  occurredAt: Date;
}

export interface OvertimeSplit {
  regularMinutes: number;
  overtimeMinutes: number;
  weeks: Array<{ weekStart: string; minutes: number; regularMinutes: number; overtimeMinutes: number }>;
}

/** Split minutes per workweek into regular (≤ threshold) and overtime. */
export function splitOvertime(entries: TimeEntryLike[], thresholdMinutes: number, enabled = true): OvertimeSplit {
  const byWeek = new Map<number, number>();
  for (const e of entries) {
    if (!Number.isInteger(e.minutes) || e.minutes <= 0) continue;
    const w = workweekOf(e.occurredAt);
    byWeek.set(w, (byWeek.get(w) ?? 0) + e.minutes);
  }
  const weeks = [...byWeek.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([w, minutes]) => {
      const regular = enabled ? Math.min(minutes, thresholdMinutes) : minutes;
      return { weekStart: new Date(w * DAY_MS).toISOString().slice(0, 10), minutes, regularMinutes: regular, overtimeMinutes: minutes - regular };
    });
  return {
    regularMinutes: weeks.reduce((s, w) => s + w.regularMinutes, 0),
    overtimeMinutes: weeks.reduce((s, w) => s + w.overtimeMinutes, 0),
    weeks,
  };
}

/** minutes × hourly rate (× multiplier) in cents, rounded half up. */
export function minutesPayCents(minutes: number, hourlyRateCents: number, multiplierBps = 10_000): number {
  if (minutes <= 0 || hourlyRateCents <= 0) return 0;
  const scaled = minutes * hourlyRateCents * multiplierBps; // ÷ (60 × 10 000)
  return Math.floor((scaled + 300_000) / 600_000);
}

// ---------------------------------------------------------------------------
// The payslip
// ---------------------------------------------------------------------------

export type PayslipLineKind = "earning" | "pre_tax_deduction" | "employee_tax" | "post_tax_deduction" | "employer_tax" | "employer_contribution";

export interface PayslipLine {
  code: string;
  label: string;
  kind: PayslipLineKind;
  amountCents: number;
  detail?: string;
}

export interface PayslipInput {
  payType: PayType;
  frequency: PayFrequency;
  annualSalaryCents: number | null;
  hourlyRateCents: number | null;
  overtime: { enabled: boolean; thresholdMinutes: number; multiplierBps: number };
  components: PayComponent[];
  /** Approved time in the period (hourly pay). */
  timeEntries: TimeEntryLike[];
  period: { start: Date; end: Date };
  /** The assignment's effective range (salary proration). */
  effective: { from: Date; to: Date | null };
  profile: TaxProfile;
  ytd: YtdWages;
  payDate: Date;
  taxTable: PayrollTaxTable;
}

export interface ComputedPayslip {
  regularMinutes: number;
  overtimeMinutes: number;
  grossCents: number;
  preTaxDeductionCents: number;
  taxableWagesCents: number;
  employeeTaxCents: number;
  postTaxDeductionCents: number;
  netCents: number;
  employerTaxCents: number;
  employerContribCents: number;
  ssWagesCents: number;
  medicareWagesCents: number;
  futaWagesCents: number;
  lines: PayslipLine[];
  warnings: string[];
  taxTable: string;
}

const money = (c: number) => `$${(c / 100).toFixed(2)}`;
const hours = (m: number) => `${(m / 60).toFixed(2)} h`;

function componentAmount(c: PayComponent, basisCents: number): number {
  return c.calc === "fixed" ? c.amountCents ?? 0 : pctOf(basisCents, c.rateBps ?? 0);
}

/** Compute one member's payslip for one period. */
export function computePayslip(input: PayslipInput): ComputedPayslip {
  const warnings: string[] = [];
  const lines: PayslipLine[] = [];
  const periods = PERIODS_PER_YEAR[input.frequency];
  if (!periods) throw new OpsError(400, `Unknown pay frequency "${input.frequency}"`);

  // 1. Base pay.
  let basePay = 0;
  let regularMinutes = 0;
  let overtimeMinutes = 0;
  if (input.payType === "salary") {
    const annual = input.annualSalaryCents ?? 0;
    if (annual <= 0) warnings.push("No annual salary set — base pay is $0.");
    const full = Math.floor((annual * 2 + periods) / (2 * periods));
    const total = daysInclusive(input.period.start, input.period.end);
    const covered = coveredDays(input.period.start, input.period.end, input.effective.from, input.effective.to);
    basePay = covered >= total ? full : Math.floor((full * covered * 2 + total) / (2 * total));
    lines.push({
      code: "salary",
      label: "Salary",
      kind: "earning",
      amountCents: basePay,
      detail: covered >= total ? `${money(annual)} a year ÷ ${periods}` : `${money(full)} × ${covered}/${total} days (prorated)`,
    });
  } else {
    const rate = input.hourlyRateCents ?? 0;
    if (rate <= 0) warnings.push("No hourly rate set — hourly pay is $0.");
    const split = splitOvertime(input.timeEntries, input.overtime.thresholdMinutes, input.overtime.enabled);
    regularMinutes = split.regularMinutes;
    overtimeMinutes = split.overtimeMinutes;
    if (regularMinutes + overtimeMinutes === 0) warnings.push("No approved time in this period.");
    const regularPay = minutesPayCents(regularMinutes, rate);
    const overtimePay = minutesPayCents(overtimeMinutes, rate, input.overtime.multiplierBps);
    basePay = regularPay + overtimePay;
    lines.push({ code: "regular", label: "Regular hours", kind: "earning", amountCents: regularPay, detail: `${hours(regularMinutes)} × ${money(rate)}` });
    if (overtimeMinutes > 0) {
      lines.push({
        code: "overtime",
        label: "Overtime",
        kind: "earning",
        amountCents: overtimePay,
        detail: `${hours(overtimeMinutes)} × ${money(rate)} × ${(input.overtime.multiplierBps / 10_000).toFixed(2)}`,
      });
    }
  }

  // 2. Allowances (percent of base pay).
  let allowances = 0;
  for (const c of input.components.filter((x) => x.kind === "allowance")) {
    const a = componentAmount(c, basePay);
    allowances += a;
    lines.push({ code: `allow_${c.code}`, label: c.label, kind: "earning", amountCents: a, detail: c.calc === "percent" ? `${(c.rateBps! / 100).toFixed(2)}% of base pay` : undefined });
  }
  const gross = basePay + allowances;

  // 3. Pre-tax deductions (percent of gross), capped at what is left.
  let preTax = 0;
  let ficaExempt = 0;
  for (const c of input.components.filter((x) => x.kind === "pre_tax_deduction")) {
    const want = componentAmount(c, gross);
    const a = Math.min(want, gross - preTax);
    if (a < want) warnings.push(`${c.label} capped at ${money(a)} (only ${money(gross - preTax)} of gross left).`);
    preTax += a;
    if (c.reducesFicaWages) ficaExempt += a;
    lines.push({ code: `pre_${c.code}`, label: c.label, kind: "pre_tax_deduction", amountCents: a, detail: c.reducesFicaWages ? "pre-tax, also exempt from FICA" : "pre-tax" });
  }
  const taxable = gross - preTax;

  // 4. Taxes from the country's table.
  const tax = input.taxTable.compute({
    periodsPerYear: periods,
    incomeTaxWagesCents: taxable,
    ficaWagesCents: gross - ficaExempt,
    profile: input.profile,
    ytd: input.ytd,
    payDate: input.payDate,
  });
  warnings.push(...tax.warnings);
  let employeeTax = 0;
  let employerTax = 0;
  for (const t of tax.lines) {
    if (t.party === "employee") employeeTax += t.amountCents;
    else employerTax += t.amountCents;
    lines.push({ code: t.code, label: t.label, kind: t.party === "employee" ? "employee_tax" : "employer_tax", amountCents: t.amountCents, detail: t.detail });
  }
  if (employeeTax > taxable) {
    // Withholding can't exceed what was earned (tiny periods with large
    // W-4 extras): cap the extra on income tax, never the FICA lines.
    const over = employeeTax - taxable;
    const fit = lines.find((l) => l.kind === "employee_tax" && l.amountCents >= over);
    if (fit) {
      fit.amountCents -= over;
      employeeTax -= over;
      warnings.push(`${fit.label} reduced by ${money(over)} so withholding doesn't exceed pay.`);
    }
  }

  // 5. Post-tax deductions (percent of gross), capped at what is left.
  let postTax = 0;
  for (const c of input.components.filter((x) => x.kind === "post_tax_deduction")) {
    const left = taxable - employeeTax - postTax;
    const want = componentAmount(c, gross);
    const a = Math.max(0, Math.min(want, left));
    if (a < want) warnings.push(`${c.label} capped at ${money(a)} so net pay doesn't go below $0.`);
    postTax += a;
    lines.push({ code: `post_${c.code}`, label: c.label, kind: "post_tax_deduction", amountCents: a });
  }

  // 6. Employer contributions (percent of gross).
  let contrib = 0;
  for (const c of input.components.filter((x) => x.kind === "employer_contribution")) {
    const a = componentAmount(c, gross);
    contrib += a;
    lines.push({ code: `er_${c.code}`, label: c.label, kind: "employer_contribution", amountCents: a });
  }

  const net = gross - preTax - employeeTax - postTax;
  return {
    regularMinutes,
    overtimeMinutes,
    grossCents: gross,
    preTaxDeductionCents: preTax,
    taxableWagesCents: taxable,
    employeeTaxCents: employeeTax,
    postTaxDeductionCents: postTax,
    netCents: net,
    employerTaxCents: employerTax,
    employerContribCents: contrib,
    ssWagesCents: tax.ssWagesCents,
    medicareWagesCents: tax.medicareWagesCents,
    futaWagesCents: tax.futaWagesCents,
    lines,
    warnings,
    taxTable: tax.tableId,
  };
}

export interface RunTotals {
  grossCents: number;
  preTaxDeductionCents: number;
  employeeTaxCents: number;
  postTaxDeductionCents: number;
  deductionCents: number;
  netCents: number;
  employerTaxCents: number;
  employerContribCents: number;
  payslipCount: number;
}

/** Σ over payslips — the run's totals (deductions = pre-tax + post-tax). */
export function runTotals(slips: Array<Pick<ComputedPayslip, "grossCents" | "preTaxDeductionCents" | "employeeTaxCents" | "postTaxDeductionCents" | "netCents" | "employerTaxCents" | "employerContribCents">>): RunTotals {
  const t: RunTotals = { grossCents: 0, preTaxDeductionCents: 0, employeeTaxCents: 0, postTaxDeductionCents: 0, deductionCents: 0, netCents: 0, employerTaxCents: 0, employerContribCents: 0, payslipCount: slips.length };
  for (const s of slips) {
    t.grossCents += s.grossCents;
    t.preTaxDeductionCents += s.preTaxDeductionCents;
    t.employeeTaxCents += s.employeeTaxCents;
    t.postTaxDeductionCents += s.postTaxDeductionCents;
    t.netCents += s.netCents;
    t.employerTaxCents += s.employerTaxCents;
    t.employerContribCents += s.employerContribCents;
  }
  t.deductionCents = t.preTaxDeductionCents + t.postTaxDeductionCents;
  if (t.netCents !== t.grossCents - t.employeeTaxCents - t.deductionCents) throw new OpsError(500, "Pay run totals don't reconcile");
  for (const v of Object.values(t)) if (v > MAX_CENTS) throw new OpsError(422, "Pay run totals exceed the maximum amount");
  return t;
}
