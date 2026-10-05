// ShapesOS — Phase 12 (people): pure payroll rules.
//   - US federal income-tax withholding (Pub 15-T 2026 Worksheet 1A, annual
//     percentage method) against worked examples computed by hand from the
//     encoded 2026 tables (standard + Step-2 checkbox, all filing statuses,
//     steps 3 / 4(a) / 4(b) / 4(c))
//   - Social Security wage-base cap, Additional Medicare, FUTA cap
//   - the flat-rate state table (flat, none, graduated → warning, override)
//   - weekly overtime, salary proration, components (allowance, pre-tax with
//     and without FICA, post-tax cap, employer contribution), payslip totals
//   - run totals, the pay-run journal (balanced) and the approval digest
// Run: npx tsx --test lib/ops/__tests__/p12-payroll.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  annualWithholdingTable,
  cappedWages,
  computeUsFederal,
  federalIncomeTaxWithholding,
  tentativeAnnualWithholding,
  US_FEDERAL_2026,
} from "../payroll/tax/us-federal";
import { computeStateFlat } from "../payroll/tax/us-state-flat";
import { payrollTaxTableFor, payrollTaxTableById, US_PAYROLL_TAX_TABLE, ZERO_YTD, divRound, pctOf, type TaxProfile } from "../payroll/tax";
import { computePayslip, minutesPayCents, parseComponents, runTotals, splitOvertime, type PayComponent, type PayslipInput } from "../payroll/rules";
import { payRunDigest } from "../payroll/runs";
import { assertBalanced, payRunPostLines, UnbalancedEntryError } from "../accounting/rules";
import { OpsError } from "../doctype";

const profile = (p: Partial<TaxProfile> = {}): TaxProfile => ({
  filingStatus: "single",
  w4Step2: false,
  dependentsCreditCents: 0,
  otherIncomeCents: 0,
  deductionsCents: 0,
  extraWithholdingCents: 0,
  stateCode: null,
  stateRateBps: null,
  ...p,
});

const fit = (wagesCents: number, periods: number, p: Partial<TaxProfile> = {}) =>
  federalIncomeTaxWithholding({ periodsPerYear: periods, incomeTaxWagesCents: wagesCents, profile: profile(p) }).withholdingCents;

const D = (s: string) => new Date(`${s}T00:00:00.000Z`);

describe("money helpers", () => {
  it("rounds half up in exact integer arithmetic", () => {
    assert.equal(pctOf(195_000, 145), 2828); // 2827.5 → 2828
    assert.equal(pctOf(100, 50), 1); // 0.5 → 1
    assert.equal(pctOf(0, 620), 0);
    assert.equal(divRound(406_000, 26), 15_615); // 15615.38
    assert.equal(divRound(716_000, 12), 59_667); // 59666.67
    assert.equal(divRound(1, 2), 1);
  });
});

describe("US federal withholding — Pub 15-T 2026 annual percentage method", () => {
  it("builds the STANDARD single table from the 2026 standard deduction and brackets", () => {
    const t = annualWithholdingTable("single", false);
    assert.deepEqual(t[0], { overCents: 0, upToCents: 750_000, rateBps: 0 }); // $16,100 − $8,600
    assert.deepEqual(t[1], { overCents: 750_000, upToCents: 1_990_000, rateBps: 1000 });
    assert.deepEqual(t[2], { overCents: 1_990_000, upToCents: 5_790_000, rateBps: 1200 });
    assert.deepEqual(t[3], { overCents: 5_790_000, upToCents: 11_320_000, rateBps: 2200 });
    assert.equal(t.at(-1)!.rateBps, 3700);
    assert.equal(t.at(-1)!.upToCents, null);
  });

  it("builds the married-jointly and Step-2 checkbox tables", () => {
    const mfj = annualWithholdingTable("married_jointly", false);
    assert.equal(mfj[0]!.upToCents, 1_930_000); // $32,200 − $12,900
    assert.deepEqual(mfj[1], { overCents: 1_930_000, upToCents: 4_410_000, rateBps: 1000 });
    const s2 = annualWithholdingTable("single", true);
    assert.equal(s2[0]!.upToCents, 805_000); // half the standard deduction
    assert.deepEqual(s2[1], { overCents: 805_000, upToCents: 1_425_000, rateBps: 1000 }); // half the 10% bracket
  });

  it("worked example: single, biweekly $2,000 → $156.15", () => {
    // 52,000 − 8,600 = 43,400; 1,240 + (43,400 − 19,900) × 12% = 4,060.00; ÷ 26
    assert.equal(tentativeAnnualWithholding(4_340_000, "single", false), 406_000);
    assert.equal(fit(200_000, 26), 15_615);
  });

  it("worked example: married jointly, monthly $8,000, $4,000 dependents credit → $263.34", () => {
    // 96,000 − 12,900 = 83,100; 2,480 + 39,000 × 12% = 7,160 → 596.67 − 333.33
    const b = federalIncomeTaxWithholding({ periodsPerYear: 12, incomeTaxWagesCents: 800_000, profile: profile({ filingStatus: "married_jointly", dependentsCreditCents: 400_000 }) });
    assert.equal(b.adjustedAnnualWageCents, 8_310_000);
    assert.equal(b.tentativeAnnualCents, 716_000);
    assert.equal(b.tentativePeriodCents, 59_667);
    assert.equal(b.creditPeriodCents, 33_333);
    assert.equal(b.withholdingCents, 26_334);
  });

  it("worked example: single, weekly $1,500, Step 2 checked → $251.67", () => {
    // 78,000 on the checkbox table: 620 + 2,280 + 6,083 + 17,100 × 24% = 13,087 ÷ 52
    assert.equal(tentativeAnnualWithholding(7_800_000, "single", true), 1_308_700);
    assert.equal(fit(150_000, 52, { w4Step2: true }), 25_167);
  });

  it("worked example: head of household, biweekly $3,000, $50 extra (4c) → $284.92", () => {
    // 78,000 − 8,600 = 69,400; 1,770 + 36,150 × 12% = 6,108 ÷ 26 = 234.92 + 50
    assert.equal(fit(300_000, 26, { filingStatus: "head_of_household", extraWithholdingCents: 5_000 }), 28_492);
  });

  it("worked example: steps 4(a) and 4(b) — single monthly $5,000, $12,000 other income, $6,000 deductions → $478.33", () => {
    // 60,000 + 12,000 − 6,000 − 8,600 = 57,400; 1,240 + 37,500 × 12% = 5,740 ÷ 12
    assert.equal(fit(500_000, 12, { otherIncomeCents: 1_200_000, deductionsCents: 600_000 }), 47_833);
  });

  it("withholds nothing below the 0% band, and credits never go negative", () => {
    assert.equal(fit(25_000, 26), 0);
    assert.equal(fit(200_000, 26, { dependentsCreditCents: 1_000_000 }), 0);
    assert.equal(fit(200_000, 26, { dependentsCreditCents: 1_000_000, extraWithholdingCents: 2_500 }), 2_500);
  });

  it("the top bracket is open-ended", () => {
    // $1,000,000 single annual: everything above 648,100 at 37%.
    const t = tentativeAnnualWithholding(100_000_000, "single", false);
    const atTop = tentativeAnnualWithholding(64_810_000, "single", false);
    assert.equal(t - atTop, Math.round((100_000_000 - 64_810_000) * 0.37));
  });
});

describe("FICA and FUTA", () => {
  const input = (fica: number, ytd = ZERO_YTD) => ({ periodsPerYear: 26, incomeTaxWagesCents: fica, ficaWagesCents: fica, profile: profile(), ytd, payDate: D("2026-06-15") });
  const line = (r: ReturnType<typeof computeUsFederal>, code: string) => r.lines.find((l) => l.code === code)?.amountCents;

  it("Social Security stops at the 2026 wage base ($184,500)", () => {
    assert.equal(US_FEDERAL_2026.socialSecurity.wageBaseCents, 18_450_000);
    const r = computeUsFederal(input(200_000, { ssWagesCents: 18_400_000, medicareWagesCents: 18_400_000, futaWagesCents: 700_000 }));
    assert.equal(r.ssWagesCents, 50_000);
    assert.equal(line(r, "us_ss_ee"), 3_100);
    assert.equal(line(r, "us_ss_er"), 3_100);
    assert.equal(line(r, "us_medicare_ee"), 2_900); // Medicare has no cap
    assert.equal(line(r, "us_futa"), 0); // FUTA base used up
    assert.ok(r.warnings.some((w) => /wage base/.test(w)));
    const capped = computeUsFederal(input(200_000, { ssWagesCents: 18_450_000, medicareWagesCents: 0, futaWagesCents: 0 }));
    assert.equal(line(capped, "us_ss_ee"), 0);
    assert.equal(cappedWages(100, 50, 120), 70);
  });

  it("Additional Medicare 0.9% only on the part above $200,000 in the year, employee only", () => {
    const r = computeUsFederal(input(300_000, { ssWagesCents: 0, medicareWagesCents: 19_900_000, futaWagesCents: 700_000 }));
    assert.equal(line(r, "us_medicare_addl"), 1_800); // 0.9% of $2,000
    assert.ok(!r.lines.some((l) => l.code === "us_medicare_addl" && l.party === "employer"));
    const below = computeUsFederal(input(300_000));
    assert.equal(line(below, "us_medicare_addl"), undefined);
  });

  it("FUTA is 0.6% on the first $7,000", () => {
    const r = computeUsFederal(input(100_000, { ssWagesCents: 0, medicareWagesCents: 0, futaWagesCents: 650_000 }));
    assert.equal(r.futaWagesCents, 50_000);
    assert.equal(line(r, "us_futa"), 300);
  });

  it("warns when the pay date is outside the shipped tax year", () => {
    const r = computeUsFederal({ ...input(100_000), payDate: D("2027-01-05") });
    assert.ok(r.warnings.some((w) => /2027/.test(w)));
  });
});

describe("flat-rate state table", () => {
  it("flat states, no-tax states, graduated states and overrides", () => {
    assert.equal(computeStateFlat("IL", null, 200_000).line?.amountCents, 9_900); // 4.95%
    assert.equal(computeStateFlat("PA", null, 100_000).line?.amountCents, 3_070);
    const tx = computeStateFlat("TX", null, 200_000);
    assert.equal(tx.line, null);
    assert.equal(tx.warning, null);
    const ca = computeStateFlat("CA", null, 200_000);
    assert.equal(ca.line, null);
    assert.match(ca.warning!, /graduated/);
    assert.equal(computeStateFlat("CA", 500, 200_000).line?.amountCents, 10_000);
    assert.equal(computeStateFlat(null, null, 200_000).line, null);
    assert.match(computeStateFlat("ZZ", null, 1).warning!, /Unknown state/);
  });

  it("the US table adds the state line among the employee taxes", () => {
    const r = US_PAYROLL_TAX_TABLE.compute({ periodsPerYear: 26, incomeTaxWagesCents: 200_000, ficaWagesCents: 200_000, profile: profile({ stateCode: "CO" }), ytd: ZERO_YTD, payDate: D("2026-03-01") });
    const i = r.lines.findIndex((l) => l.code === "us_state_co");
    assert.ok(i > 0);
    assert.ok(r.lines.slice(0, i).every((l) => l.party === "employee"));
    assert.equal(r.lines[i]!.amountCents, 8_800); // 4.4%
    assert.equal(r.tableId, "us-federal-2026+us-state-flat-2026");
  });

  it("the registry is pluggable per country and refuses unknown countries", () => {
    assert.equal(payrollTaxTableFor("us", D("2026-01-01")).country, "US");
    assert.throws(() => payrollTaxTableFor("GB", D("2026-01-01")), (e: unknown) => e instanceof OpsError && e.status === 422);
    assert.equal(payrollTaxTableById("us-federal-2026+us-state-flat-2026", D("2026-01-01"))?.country, "US");
    assert.equal(payrollTaxTableById("nope", D("2026-01-01")), null);
  });
});

describe("overtime and hourly pay", () => {
  it("splits minutes per Monday-based workweek at the threshold", () => {
    const e = (day: string, minutes: number) => ({ occurredAt: new Date(`${day}T15:00:00Z`), minutes });
    // 2026-03-02 is a Monday. Week 1: 5 × 9 h = 45 h; week 2: 30 h.
    const split = splitOvertime(
      [e("2026-03-02", 540), e("2026-03-03", 540), e("2026-03-04", 540), e("2026-03-05", 540), e("2026-03-06", 540), e("2026-03-09", 900), e("2026-03-15", 900)],
      2400,
    );
    assert.equal(split.weeks.length, 2);
    assert.deepEqual(split.weeks[0], { weekStart: "2026-03-02", minutes: 2700, regularMinutes: 2400, overtimeMinutes: 300 });
    assert.equal(split.regularMinutes, 2400 + 1800);
    assert.equal(split.overtimeMinutes, 300);
    const off = splitOvertime([e("2026-03-02", 3000)], 2400, false);
    assert.equal(off.overtimeMinutes, 0);
  });

  it("pays minutes at the rate and overtime at the multiplier (half up)", () => {
    assert.equal(minutesPayCents(4200, 2000), 140_000); // 70 h × $20
    assert.equal(minutesPayCents(300, 2000, 15_000), 15_000); // 5 h × $30
    assert.equal(minutesPayCents(1, 1000), 17); // 16.67¢
    assert.equal(minutesPayCents(0, 2000), 0);
  });
});

describe("components", () => {
  it("validates and normalises", () => {
    const c = parseComponents([{ code: "401K", label: "401(k)", kind: "pre_tax_deduction", calc: "percent", rateBps: 500 }]);
    assert.deepEqual(c, [{ code: "401k", label: "401(k)", kind: "pre_tax_deduction", calc: "percent", rateBps: 500 }]);
    assert.deepEqual(parseComponents(null), []);
    for (const bad of [
      [{ code: "", kind: "allowance", amountCents: 1 }],
      [{ code: "x", kind: "bonus", amountCents: 1 }],
      [{ code: "x", kind: "allowance", amountCents: -1 }],
      [{ code: "x", kind: "allowance", calc: "percent", rateBps: 20_000 }],
      [{ code: "x", kind: "allowance", amountCents: 1, reducesFicaWages: true }],
      [{ code: "x", kind: "allowance", amountCents: 1 }, { code: "x", kind: "allowance", amountCents: 2 }],
      "nope",
    ]) {
      assert.throws(() => parseComponents(bad), (e: unknown) => e instanceof OpsError && e.status === 400);
    }
  });
});

describe("the payslip", () => {
  const base = (over: Partial<PayslipInput> = {}): PayslipInput => ({
    payType: "salary",
    frequency: "biweekly",
    annualSalaryCents: 5_200_000,
    hourlyRateCents: null,
    overtime: { enabled: true, thresholdMinutes: 2400, multiplierBps: 15_000 },
    components: [],
    timeEntries: [],
    period: { start: D("2026-03-02"), end: D("2026-03-15") },
    effective: { from: D("2025-01-01"), to: null },
    profile: profile(),
    ytd: ZERO_YTD,
    payDate: D("2026-03-20"),
    taxTable: US_PAYROLL_TAX_TABLE,
    ...over,
  });

  it("salary with allowance, pre-tax (with and without FICA), post-tax and employer contribution — every total", () => {
    const components: PayComponent[] = parseComponents([
      { code: "phone", label: "Phone allowance", kind: "allowance", amountCents: 5_000 },
      { code: "401k", label: "401(k)", kind: "pre_tax_deduction", calc: "percent", rateBps: 500 },
      { code: "health", label: "Health premium", kind: "pre_tax_deduction", amountCents: 10_000, reducesFicaWages: true },
      { code: "garnish", label: "Garnishment", kind: "post_tax_deduction", amountCents: 2_000 },
      { code: "match", label: "401(k) match", kind: "employer_contribution", calc: "percent", rateBps: 300 },
    ]);
    const p = computePayslip(base({ components }));
    assert.equal(p.grossCents, 205_000); // 2,000.00 + 50.00
    assert.equal(p.preTaxDeductionCents, 20_250); // 5% of gross + 100.00
    assert.equal(p.taxableWagesCents, 184_750);
    assert.equal(p.ssWagesCents, 195_000); // health is FICA-exempt, 401(k) is not
    const amt = (code: string) => p.lines.find((l) => l.code === code)?.amountCents;
    assert.equal(amt("us_fit"), 13_785); // 48,035 − 8,600 = 39,435 → 3,584.20 ÷ 26
    assert.equal(amt("us_ss_ee"), 12_090);
    assert.equal(amt("us_medicare_ee"), 2_828);
    assert.equal(p.employeeTaxCents, 28_703);
    assert.equal(p.postTaxDeductionCents, 2_000);
    assert.equal(p.netCents, 154_047);
    assert.equal(p.employerTaxCents, 12_090 + 2_828 + 1_170); // + FUTA 0.6% of 1,950
    assert.equal(p.employerContribCents, 6_150);
    assert.equal(p.netCents, p.grossCents - p.preTaxDeductionCents - p.employeeTaxCents - p.postTaxDeductionCents);
    assert.equal(p.taxTable, "us-federal-2026+us-state-flat-2026");
  });

  it("prorates salary by calendar days when the assignment starts mid-period", () => {
    const p = computePayslip(base({ effective: { from: D("2026-03-09"), to: null } }));
    assert.equal(p.lines.find((l) => l.code === "salary")!.amountCents, 100_000); // 7 of 14 days
    const ended = computePayslip(base({ effective: { from: D("2025-01-01"), to: D("2026-03-05") } }));
    assert.equal(ended.lines.find((l) => l.code === "salary")!.amountCents, Math.round((200_000 * 4) / 14));
  });

  it("hourly pay from approved time with weekly overtime", () => {
    const e = (day: string, minutes: number) => ({ occurredAt: new Date(`${day}T15:00:00Z`), minutes });
    const p = computePayslip(
      base({
        payType: "hourly",
        annualSalaryCents: null,
        hourlyRateCents: 2_000,
        timeEntries: [e("2026-03-02", 1350), e("2026-03-04", 1350), e("2026-03-10", 1800)],
      }),
    );
    assert.equal(p.regularMinutes, 4200);
    assert.equal(p.overtimeMinutes, 300);
    assert.equal(p.grossCents, 155_000); // 70 h × 20 + 5 h × 30
    assert.equal(p.lines.find((l) => l.code === "overtime")!.amountCents, 15_000);
    const none = computePayslip(base({ payType: "hourly", annualSalaryCents: null, hourlyRateCents: 2_000 }));
    assert.equal(none.grossCents, 0);
    assert.ok(none.warnings.some((w) => /No approved time/.test(w)));
  });

  it("caps deductions so net pay never goes negative", () => {
    const p = computePayslip(
      base({
        annualSalaryCents: 520_000, // $200 a period
        components: parseComponents([{ code: "garnish", label: "Garnishment", kind: "post_tax_deduction", amountCents: 50_000 }]),
      }),
    );
    assert.equal(p.netCents, 0);
    assert.ok(p.postTaxDeductionCents < 50_000);
    assert.ok(p.warnings.some((w) => /capped/.test(w)));
  });

  it("withholds state tax from the work state", () => {
    const p = computePayslip(base({ profile: profile({ stateCode: "IL" }) }));
    assert.equal(p.lines.find((l) => l.code === "us_state_il")!.amountCents, 9_900);
  });
});

describe("pay-run totals, journal and digest", () => {
  const slip = (g: number, pre: number, ee: number, post: number, er: number, c: number) => ({
    grossCents: g,
    preTaxDeductionCents: pre,
    employeeTaxCents: ee,
    postTaxDeductionCents: post,
    netCents: g - pre - ee - post,
    employerTaxCents: er,
    employerContribCents: c,
  });

  it("run totals add up and reconcile", () => {
    const t = runTotals([slip(205_000, 20_250, 28_703, 2_000, 16_088, 6_150), slip(100_000, 0, 15_000, 0, 8_000, 0)]);
    assert.equal(t.grossCents, 305_000);
    assert.equal(t.deductionCents, 22_250);
    assert.equal(t.netCents, 305_000 - 43_703 - 22_250);
    assert.equal(t.payslipCount, 2);
  });

  it("the pay-run entry balances: wages + employer cost = liabilities + net", () => {
    const t = { ...slip(305_000, 20_250, 43_703, 2_000, 24_088, 6_150) };
    const lines = payRunPostLines(t);
    const total = assertBalanced(lines);
    assert.equal(total, 305_000 + 24_088 + 6_150);
    const by = (key: string) => lines.find((l) => "key" in l.account && l.account.key === key)!;
    assert.equal(by("payroll_wages").debitCents, 305_000);
    assert.equal(by("payroll_taxes").debitCents, 24_088);
    assert.equal(by("payroll_benefits").debitCents, 6_150);
    assert.equal(by("payroll_tax_payable").creditCents, 43_703 + 24_088);
    assert.equal(by("payroll_deductions_payable").creditCents, 20_250 + 2_000 + 6_150);
    assert.equal(by("wages_payable").creditCents, t.netCents);
    assert.throws(() => payRunPostLines({ ...t, netCents: t.netCents + 1 }), UnbalancedEntryError);
  });

  it("the digest binds every payslip and ignores order", () => {
    const run = { periodStart: D("2026-03-02"), periodEnd: D("2026-03-15"), payDate: D("2026-03-20") };
    const a = { memberId: "a", ...slip(100, 0, 10, 0, 8, 0), lines: [{ code: "salary", label: "Salary", kind: "earning" as const, amountCents: 100 }] };
    const b = { memberId: "b", ...slip(200, 0, 20, 0, 16, 0), lines: [] };
    assert.equal(payRunDigest(run, [a, b]), payRunDigest(run, [b, a]));
    assert.notEqual(payRunDigest(run, [a, b]), payRunDigest(run, [{ ...a, netCents: 91 }, b]));
    assert.notEqual(payRunDigest(run, [a, b]), payRunDigest({ ...run, payDate: D("2026-03-21") }, [a, b]));
  });
});

describe("payroll and event tools: never automated where it matters", () => {
  it("approving and posting payroll are Tier 3; drafting is Tier 0; event writes always ask", async () => {
    const { evaluateTier } = await import("@/lib/orchestrator/authority");
    const { TOOL_ACTION, TOOL_GROUP } = await import("@/lib/chat/tools");
    const { OPS_TOOLS } = await import("@/lib/chat/ops-tools");
    const { KNOWN_ACTION_DEFS } = await import("@/lib/automation/actions");
    const settings = { smallActionThresholdCents: 10_000, automationAllows: true };
    assert.equal(evaluateTier({ kind: TOOL_ACTION.ops_payroll_request_approval! }, settings), 3);
    assert.equal(evaluateTier({ kind: TOOL_ACTION.ops_payroll_request_posting! }, settings), 3);
    assert.equal(evaluateTier({ kind: TOOL_ACTION.ops_payroll_draft_run! }, settings), 0);
    assert.equal(evaluateTier({ kind: TOOL_ACTION.ops_events_create_event! }, settings), 2);
    const names = OPS_TOOLS.map((t) => t.name);
    for (const n of ["ops_payroll_overview", "ops_payroll_draft_run", "ops_payroll_request_approval", "ops_payroll_request_posting", "ops_events_overview", "ops_events_create_event", "ops_events_register"]) {
      assert.ok(names.includes(n), n);
      assert.ok(TOOL_GROUP[n], `${n} group`);
    }
    for (const n of names.filter((x) => x.startsWith("ops_payroll"))) assert.equal(OPS_TOOLS.find((t) => t.name === n)!.minRole, "admin", n);
    const known = new Set(KNOWN_ACTION_DEFS.map((d) => d.action));
    for (const a of ["draft_pay_run", "approve_pay_run", "post_pay_run", "write_event"]) assert.ok(known.has(a), a);
  });
});
