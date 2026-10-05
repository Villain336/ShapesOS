// ShapesOS — Phase 14 (connectors): Gusto ↔ ShapesOS payroll mapping (PURE:
// no I/O). Shapes are the documented ones (lib/bizsync/gusto/api.ts cites
// the pages); the unit tests run against the documented example JSON.
//
// WHAT IS SENT (into an UNPROCESSED Gusto payroll — Gusto computes taxes):
//   hourly people   approved timesheet hours → the employee's "Regular Hours"
//                   and "Overtime" hourly compensations (absolute hours for
//                   the period, so re-sending the same run is harmless);
//   salaried people nothing — Gusto pays salary from the job's compensation
//                   in Gusto (sending it would pay it twice);
//   allowances, deductions, employer contributions, reimbursements
//                   NOT sent: Gusto runs the benefits/deductions configured in
//                   Gusto, and ShapesOS reimburses expense claims itself
//                   (OPS_EXPENSE_REIMBURSE) — sending them would pay twice.
//                   Each one is listed as a warning so the person can add it
//                   in Gusto before submitting.
// WHAT COMES BACK (from the PROCESSED payroll):
//   gross_pay, net_pay, taxes[{ name, employer, amount }], benefits
//   [{ employee_deduction, company_contribution }], deductions[{ amount }]
//   → the payslip's gross, employee / employer taxes, deductions,
//   contributions and net. Gusto doesn't say which deductions are pre-tax, so
//   every employee deduction is recorded as "deductions (from Gusto)"; the
//   journal posts all deductions to the same liability either way.

import { createHash } from "node:crypto";
import type { PayslipLine } from "@/lib/ops/payroll/rules";
import type { GustoEmployee, GustoEmployeeCompensation, GustoPayroll, GustoPayrollUpdate } from "./api";

/** "1953.31" / 1953.31 → 195331 (exact for the 2-decimal strings Gusto sends). */
export function toCents(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const s = typeof v === "number" ? v.toFixed(2) : String(v).trim();
  const m = /^(-)?(\d+)(?:\.(\d{1,3}))?$/.exec(s);
  if (!m) return null;
  const frac = ((m[3] ?? "") + "000").slice(0, 3);
  // Round half up on the third decimal (Gusto sends cents; be safe anyway).
  const milli = Number(m[2]) * 1000 + Number(frac);
  const cents = Math.floor((milli + 5) / 10);
  return m[1] ? -cents : cents;
}

/** Minutes → Gusto's hours string (thousandths, as in "10.000"). */
export function hoursString(minutes: number): string {
  return (Math.max(0, minutes) / 60).toFixed(3);
}

export function employeeName(e: Pick<GustoEmployee, "first_name" | "last_name" | "preferred_first_name">): string {
  return `${e.preferred_first_name || e.first_name || ""} ${e.last_name || ""}`.trim() || "Unnamed employee";
}

// ---------------------------------------------------------------------------
// Employee matching (by email; a person confirms on the Business sync page)
// ---------------------------------------------------------------------------

export interface MemberLike {
  id: string;
  name: string;
  email: string | null;
  status?: string;
}

export interface EmployeeMatch {
  memberId: string;
  employeeUuid: string;
  email: string;
}

const norm = (e: string | null | undefined) => (e ?? "").trim().toLowerCase();

/** Unique email matches (personal or work email). Duplicates on either side are ambiguous, never guessed. */
export function matchEmployeesByEmail(members: MemberLike[], employees: GustoEmployee[]): { matches: EmployeeMatch[]; ambiguous: string[] } {
  const byEmail = new Map<string, MemberLike[]>();
  for (const m of members) {
    const e = norm(m.email);
    if (e) byEmail.set(e, [...(byEmail.get(e) ?? []), m]);
  }
  const empByEmail = new Map<string, GustoEmployee[]>();
  for (const emp of employees) {
    for (const e of new Set([norm(emp.email), norm(emp.work_email)].filter(Boolean))) empByEmail.set(e, [...(empByEmail.get(e) ?? []), emp]);
  }
  const matches: EmployeeMatch[] = [];
  const ambiguous: string[] = [];
  const usedMembers = new Set<string>();
  const usedEmployees = new Set<string>();
  for (const [email, emps] of empByEmail) {
    const ms = byEmail.get(email) ?? [];
    if (ms.length === 0) continue;
    if (ms.length > 1 || emps.length > 1) {
      ambiguous.push(email);
      continue;
    }
    const m = ms[0]!;
    const emp = emps[0]!;
    if (usedMembers.has(m.id) || usedEmployees.has(emp.uuid)) continue;
    usedMembers.add(m.id);
    usedEmployees.add(emp.uuid);
    matches.push({ memberId: m.id, employeeUuid: emp.uuid, email });
  }
  return { matches, ambiguous };
}

// ---------------------------------------------------------------------------
// Send: computed payslips → PUT /payrolls/{id} body
// ---------------------------------------------------------------------------

export interface SlipForSend {
  memberId: string;
  memberName: string;
  payType: string;
  regularMinutes: number;
  overtimeMinutes: number;
  lines: PayslipLine[];
}

export interface SendPlan {
  body: GustoPayrollUpdate;
  sent: Array<{ memberName: string; employeeUuid: string; regularHours: string; overtimeHours: string }>;
  salaried: Array<{ memberName: string; employeeUuid: string }>;
  skipped: Array<{ memberName: string; reason: string }>;
  warnings: string[];
}

const money = (c: number) => `$${(c / 100).toFixed(2)}`;
const isRegular = (name: string) => /^regular( hours)?$/i.test(name.trim());
const isOvertime = (name: string) => /^overtime$/i.test(name.trim());

/**
 * Plan the payroll update from a prepared payroll (its per-employee
 * versions and compensation names/jobs) and the run's payslips. Only
 * CONFIRMED links (memberId → Gusto employee uuid) are used.
 */
export function planPayrollUpdate(prepared: GustoPayroll, slips: SlipForSend[], links: ReadonlyMap<string, string>): SendPlan {
  const plan: SendPlan = { body: { employee_compensations: [] }, sent: [], salaried: [], skipped: [], warnings: [] };
  const comps = new Map((prepared.employee_compensations ?? []).map((c) => [c.employee_uuid, c]));
  let otherLines = 0;
  for (const s of slips) {
    const uuid = links.get(s.memberId);
    if (!uuid) {
      plan.skipped.push({ memberName: s.memberName, reason: "not matched to a Gusto employee — confirm the match on Settings → Connectors → Business sync" });
      continue;
    }
    const comp = comps.get(uuid);
    if (!comp) {
      plan.skipped.push({ memberName: s.memberName, reason: "not on this Gusto payroll" });
      continue;
    }
    if (comp.excluded) {
      plan.skipped.push({ memberName: s.memberName, reason: "excluded from this payroll in Gusto" });
      continue;
    }
    for (const l of s.lines) {
      if (l.kind === "earning" && l.code.startsWith("allow_") && l.amountCents > 0) plan.warnings.push(`${s.memberName}: allowance "${l.label}" (${money(l.amountCents)}) isn't sent — add it in Gusto as an earning if it applies.`);
      else if ((l.kind === "pre_tax_deduction" || l.kind === "post_tax_deduction" || l.kind === "employer_contribution") && l.amountCents > 0) otherLines += 1;
    }
    if (s.payType !== "hourly") {
      plan.salaried.push({ memberName: s.memberName, employeeUuid: uuid });
      continue;
    }
    if (!comp.version) {
      plan.skipped.push({ memberName: s.memberName, reason: "Gusto returned no version for this employee — prepare the payroll again" });
      continue;
    }
    const hourly = comp.hourly_compensations ?? [];
    const regular = hourly.find((h) => isRegular(h.name));
    const overtime = hourly.find((h) => isOvertime(h.name));
    if (!regular) {
      plan.skipped.push({ memberName: s.memberName, reason: "has no Regular Hours compensation in Gusto (is the job hourly in Gusto?)" });
      continue;
    }
    if (s.overtimeMinutes > 0 && !overtime) {
      plan.skipped.push({ memberName: s.memberName, reason: "has overtime but no Overtime compensation in Gusto" });
      continue;
    }
    const entry: GustoPayrollUpdate["employee_compensations"][number] = {
      employee_uuid: uuid,
      version: comp.version,
      hourly_compensations: [
        { name: regular.name, hours: hoursString(s.regularMinutes), ...(regular.job_uuid ? { job_uuid: regular.job_uuid } : {}) },
        ...(overtime ? [{ name: overtime.name, hours: hoursString(s.overtimeMinutes), ...(overtime.job_uuid ? { job_uuid: overtime.job_uuid } : {}) }] : []),
      ],
    };
    plan.body.employee_compensations.push(entry);
    plan.sent.push({ memberName: s.memberName, employeeUuid: uuid, regularHours: hoursString(s.regularMinutes), overtimeHours: overtime ? hoursString(s.overtimeMinutes) : "0.000" });
  }
  if (otherLines > 0) plan.warnings.push("Deductions and employer contributions aren't sent — Gusto applies the benefits and deductions set up in Gusto.");
  return plan;
}

/** Split an update into Gusto's 100-per-request batches. PURE. */
export function chunkUpdate(body: GustoPayrollUpdate, size = 100): GustoPayrollUpdate[] {
  const out: GustoPayrollUpdate[] = [];
  for (let i = 0; i < body.employee_compensations.length; i += size) out.push({ employee_compensations: body.employee_compensations.slice(i, i + size) });
  return out;
}

/**
 * The send's idempotency key: the run, the exact computed figures it was
 * computed from (the run's compute digest) and the Gusto payroll. Sending
 * the same key twice is a no-op; a recompute (new digest) needs a new send.
 */
export function sendKey(runId: string, computeDigest: string, payrollUuid: string): string {
  return createHash("sha256").update(`gusto-send\n${runId}\n${computeDigest}\n${payrollUuid}`).digest("hex");
}

/** The unprocessed regular payroll whose pay period is exactly the run's. */
export function pickPayrollForPeriod(payrolls: GustoPayroll[], periodStart: string, periodEnd: string): { payroll: GustoPayroll | null; ambiguous: boolean } {
  const hits = payrolls.filter((p) => !p.processed && !p.off_cycle && p.pay_period?.start_date === periodStart && p.pay_period?.end_date === periodEnd);
  return { payroll: hits.length === 1 ? hits[0]! : null, ambiguous: hits.length > 1 };
}

// ---------------------------------------------------------------------------
// Sync back: a processed payroll's employee compensation → payslip figures
// ---------------------------------------------------------------------------

export interface GustoSlipFigures {
  grossCents: number;
  preTaxDeductionCents: number;
  taxableWagesCents: number;
  employeeTaxCents: number;
  postTaxDeductionCents: number;
  netCents: number;
  employerTaxCents: number;
  employerContribCents: number;
  lines: PayslipLine[];
  warnings: string[];
}

export class GustoMappingError extends Error {}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "item";

/** Map one processed employee compensation to payslip figures that reconcile. */
export function payslipFromGusto(comp: GustoEmployeeCompensation): GustoSlipFigures {
  const gross = toCents(comp.gross_pay);
  const net = toCents(comp.net_pay);
  if (gross === null || net === null) throw new GustoMappingError(`Gusto sent no gross/net pay for employee ${comp.employee_uuid} — is the payroll processed?`);
  const lines: PayslipLine[] = [];
  const warnings: string[] = [];

  // Earnings as Gusto itemised them (hourly amounts exist once processed).
  const earnings: PayslipLine[] = [];
  for (const h of comp.hourly_compensations ?? []) {
    const a = toCents(h.amount);
    if (a && a > 0) earnings.push({ code: `gusto_${slug(h.name)}`, label: h.name, kind: "earning", amountCents: a, detail: `${Number(h.hours).toFixed(2)} h (Gusto)` });
  }
  for (const f of comp.fixed_compensations ?? []) {
    const a = toCents(f.amount);
    if (a && a > 0 && !/^reimbursement$/i.test(f.name)) earnings.push({ code: `gusto_${slug(f.name)}`, label: f.name, kind: "earning", amountCents: a, detail: "Gusto" });
  }
  const itemised = earnings.reduce((s, l) => s + l.amountCents, 0);
  if (earnings.length > 0 && itemised === gross) lines.push(...earnings);
  else lines.push({ code: "gusto_gross", label: "Gross pay", kind: "earning", amountCents: gross, detail: "as computed by Gusto" });

  let employeeTax = 0;
  let employerTax = 0;
  for (const t of comp.taxes ?? []) {
    const a = toCents(t.amount) ?? 0;
    if (a === 0) continue;
    if (t.employer) employerTax += a;
    else employeeTax += a;
    lines.push({ code: `gusto_tax_${slug(t.name)}`, label: t.name, kind: t.employer ? "employer_tax" : "employee_tax", amountCents: a, detail: "Gusto" });
  }

  let contrib = 0;
  let listedDeductions = 0;
  for (const b of comp.benefits ?? []) {
    const ee = toCents(b.employee_deduction) ?? 0;
    const er = toCents(b.company_contribution) ?? 0;
    if (ee > 0) {
      listedDeductions += ee;
      lines.push({ code: `gusto_ben_${slug(b.name ?? "benefit")}`, label: b.name ?? "Benefit", kind: "post_tax_deduction", amountCents: ee, detail: "benefit deduction (Gusto)" });
    }
    if (er > 0) {
      contrib += er;
      lines.push({ code: `gusto_er_${slug(b.name ?? "benefit")}`, label: `${b.name ?? "Benefit"} (employer)`, kind: "employer_contribution", amountCents: er, detail: "Gusto" });
    }
  }
  for (const d of comp.deductions ?? []) {
    const a = toCents(d.amount) ?? 0;
    if (a <= 0) continue;
    listedDeductions += a;
    lines.push({ code: `gusto_ded_${slug(d.name ?? "deduction")}`, label: d.name ?? "Deduction", kind: "post_tax_deduction", amountCents: a, detail: "Gusto" });
  }

  // Everything between gross and net that isn't a tax is a deduction —
  // derived, so the payslip always reconciles with Gusto's net pay.
  const deductions = gross - employeeTax - net;
  if (deductions < 0) throw new GustoMappingError(`Gusto's figures don't reconcile for employee ${comp.employee_uuid}: net pay exceeds gross minus taxes`);
  if (deductions > listedDeductions) {
    lines.push({ code: "gusto_other", label: "Other withholdings", kind: "post_tax_deduction", amountCents: deductions - listedDeductions, detail: "e.g. garnishments or cash tips (Gusto)" });
  } else if (deductions < listedDeductions) {
    warnings.push(`Gusto's itemised deductions (${money(listedDeductions)}) exceed gross − taxes − net (${money(deductions)}); the payslip uses the net pay Gusto paid.`);
  }
  warnings.push("Taxes and net pay computed by Gusto.");
  return {
    grossCents: gross,
    preTaxDeductionCents: 0,
    taxableWagesCents: gross,
    employeeTaxCents: employeeTax,
    postTaxDeductionCents: deductions,
    netCents: net,
    employerTaxCents: employerTax,
    employerContribCents: contrib,
    lines,
    warnings,
  };
}

/**
 * Has Gusto paid this payroll? Processed (submitted) and not failed, and its
 * check date — the day employees are paid — has arrived. Gusto has no
 * separate "paid" flag in the App Integrations payroll object; a cancelled
 * payroll goes back to unprocessed, so it never counts.
 */
export function gustoPayrollPaid(p: Pick<GustoPayroll, "processed" | "check_date" | "processing_request">, today: Date): boolean {
  if (!p.processed || !p.check_date) return false;
  const status = p.processing_request?.status;
  if (status && status !== "submit_success") return false;
  return p.check_date <= today.toISOString().slice(0, 10);
}
