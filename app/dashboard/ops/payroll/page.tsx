// ShapesOS — Phase 12 (people): /dashboard/ops/payroll.
// Admins: pay runs, salary structures and who is on which structure (with
// their W-4 tax profile). Everyone else sees only their own payslips.
// Approving and posting a run are Tier-3 decisions taken on the run's page.

import Link from "next/link";
import { Banknote, ShieldAlert } from "lucide-react";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { financePageActor } from "@/lib/ops/finance/page";
import { PAYROLL_TAX_DISCLAIMER } from "@/lib/ops/payroll/tax";
import { US_PAYROLL_TAX_TABLE } from "@/lib/ops/payroll/tax";
import { US_STATE_CODES } from "@/lib/ops/payroll/tax/us-state-flat";
import { payRunLabel } from "@/lib/ops/payroll/runs";
import { DataTable, Empty, FinanceHeader, Panel, Pill, cellCls, fmtDay, money, numCls, rowCls } from "@/components/ops-finance/kit";
import { PlanFeatureNotice } from "@/components/billing/PlanFeatureNotice";
import { EndAssignmentButton, NewAssignmentButton, NewPayRunButton, NewStructureButton } from "@/components/ops-people/PayrollClient";

export const dynamic = "force-dynamic";
export const metadata = { title: "Payroll — ShapesOS", description: "Salary structures, pay runs and payslips." };

const RUN_STATE: Record<string, string> = {
  draft: "Draft",
  computed: "Computed — needs approval",
  approved: "Approved — not posted",
  posted: "Posted",
  cancelled: "Cancelled",
};

const FREQ: Record<string, string> = { weekly: "Weekly", biweekly: "Every two weeks", semimonthly: "Twice a month", monthly: "Monthly" };
const FILING: Record<string, string> = { single: "Single", married_jointly: "Married jointly", head_of_household: "Head of household" };

function Disclaimer() {
  return (
    <div className="flex items-start gap-3 rounded-md bg-paper px-4 py-3 shadow-hairline">
      <ShieldAlert size={18} className="mt-0.5 shrink-0 text-ink" aria-hidden />
      <div className="text-md">
        <p className="font-semibold">Verify with your accountant</p>
        <p className="text-muted">
          {PAYROLL_TAX_DISCLAIMER} Tables: {US_PAYROLL_TAX_TABLE.label}. ShapesOS never pays anyone — net pay is recorded as owed until you pay it through your bank or payroll provider.
        </p>
      </div>
    </div>
  );
}

export default async function PayrollPage() {
  const actor = await financePageActor();
  const ws = actor.workspaceId;

  if (!actor.isAdmin) {
    const mine = await withWorkspaceScope(ws, async (tx) => {
      const member = await tx.opsTeamMember.findFirst({ where: { workspaceId: ws, userId: actor.userId }, select: { id: true } });
      if (!member) return [];
      return tx.opsPayslip.findMany({
        where: { workspaceId: ws, memberId: member.id, payRun: { status: { in: ["approved", "posted"] } } },
        orderBy: { createdAt: "desc" },
        take: 50,
        include: { payRun: { select: { number: true, payDate: true, periodStart: true, periodEnd: true } } },
      });
    });
    return (
      <div className="flex flex-col gap-6">
        <FinanceHeader title="Your payslips" description="Payslips from approved pay runs. Payroll itself is managed by workspace admins." />
        <Disclaimer />
        <Panel>
          {mine.length === 0 ? (
            <Empty icon={<Banknote size={28} aria-hidden />} title="No payslips yet">
              Payslips appear here once a pay run you're in has been approved.
            </Empty>
          ) : (
            <DataTable head={[{ label: "Pay date" }, { label: "Period" }, { label: "Gross", align: "right" }, { label: "Net pay", align: "right" }, { label: "" }]}>
              {mine.map((s) => (
                <tr key={s.id} className={rowCls}>
                  <td className={`${cellCls} tabular-nums`}>{fmtDay(s.payRun.payDate)}</td>
                  <td className={`${cellCls} tabular-nums text-muted`}>
                    {fmtDay(s.payRun.periodStart)} – {fmtDay(s.payRun.periodEnd)}
                  </td>
                  <td className={numCls}>{money(s.grossCents)}</td>
                  <td className={numCls}>{money(s.netCents)}</td>
                  <td className={`${cellCls} text-right`}>
                    <a className="text-sm font-semibold underline" href={`/api/ops/payslips/${s.id}/pdf`} target="_blank" rel="noreferrer">
                      PDF
                    </a>
                  </td>
                </tr>
              ))}
            </DataTable>
          )}
        </Panel>
      </div>
    );
  }

  const data = await withWorkspaceScope(ws, async (tx) => {
    const [runs, structures, assignments, members] = await Promise.all([
      tx.opsPayRun.findMany({ where: { workspaceId: ws }, orderBy: [{ periodEnd: "desc" }, { createdAt: "desc" }], take: 50 }),
      tx.opsSalaryStructure.findMany({ where: { workspaceId: ws }, orderBy: { name: "asc" }, include: { _count: { select: { assignments: true } } } }),
      tx.opsSalaryAssignment.findMany({
        where: { workspaceId: ws },
        orderBy: [{ effectiveFrom: "desc" }],
        take: 300,
        include: { member: { select: { name: true } }, structure: { select: { name: true, payType: true } } },
      }),
      tx.opsTeamMember.findMany({ where: { workspaceId: ws, status: "active" }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    ]);
    return { runs, structures, assignments, members };
  });
  const now = new Date();
  const current = data.assignments.filter((a) => !a.effectiveTo || a.effectiveTo >= new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())));

  return (
    <div className="flex flex-col gap-6">
      <FinanceHeader
        title="Payroll"
        description="Compute pay from salary structures and approved timesheets, approve it, and post it to the books. Approving and posting always ask a person."
        actions={<NewPayRunButton />}
      />
      {/* Phase 15.3 (pricing): explains the payroll gate on plans without it. */}
      <PlanFeatureNotice workspaceId={ws} userId={actor.userId} feature="payroll" />
      <Disclaimer />
      <Panel title="Pay runs">
        {data.runs.length === 0 ? (
          <Empty icon={<Banknote size={28} aria-hidden />} title="No pay runs yet">
            Set up a salary structure, assign it to your team, then start a pay run.
          </Empty>
        ) : (
          <DataTable
            head={[{ label: "Run" }, { label: "Period" }, { label: "Pay date" }, { label: "State" }, { label: "People", align: "right" }, { label: "Gross", align: "right" }, { label: "Net pay", align: "right" }, { label: "Employer taxes", align: "right" }]}
          >
            {data.runs.map((r) => (
              <tr key={r.id} className={rowCls}>
                <td className={`${cellCls} font-semibold`}>
                  <Link className="underline-offset-2 hover:underline" href={`/dashboard/ops/payroll/${r.id}`}>
                    {payRunLabel(r)}
                  </Link>
                </td>
                <td className={`${cellCls} tabular-nums text-muted`}>
                  {fmtDay(r.periodStart)} – {fmtDay(r.periodEnd)}
                </td>
                <td className={`${cellCls} tabular-nums`}>{fmtDay(r.payDate)}</td>
                <td className={cellCls}>
                  <Pill>{RUN_STATE[r.status] ?? r.status}</Pill>
                </td>
                <td className={numCls}>{r.payslipCount}</td>
                <td className={numCls}>{money(r.grossCents)}</td>
                <td className={numCls}>{money(r.netCents)}</td>
                <td className={numCls}>{money(r.employerTaxCents)}</td>
              </tr>
            ))}
          </DataTable>
        )}
      </Panel>
      <Panel title="Salary structures" actions={<NewStructureButton />}>
        {data.structures.length === 0 ? (
          <p className="px-5 py-5 text-md text-muted">No structures yet. A structure is the pay rule: salary or hourly, how often, overtime, and any allowances or deductions.</p>
        ) : (
          <DataTable head={[{ label: "Structure" }, { label: "Pay" }, { label: "Frequency" }, { label: "Components" }, { label: "Tax table" }, { label: "Assigned", align: "right" }]}>
            {data.structures.map((s) => {
              const comps = Array.isArray(s.components) ? (s.components as Array<{ label?: string; code?: string }>) : [];
              return (
                <tr key={s.id} className={rowCls}>
                  <td className={`${cellCls} font-semibold`}>
                    {s.name} {s.active ? null : <Pill className="ml-2">Inactive</Pill>}
                  </td>
                  <td className={`${cellCls} tabular-nums`}>
                    {s.payType === "salary" ? `${money(s.annualSalaryCents)} a year` : `${money(s.hourlyRateCents)} an hour${s.overtimeEnabled ? `, ${(s.overtimeMultiplierBps / 10_000).toFixed(1)}× past ${s.overtimeThresholdMinutes / 60} h/week` : ""}`}
                  </td>
                  <td className={cellCls}>{FREQ[s.payFrequency] ?? s.payFrequency}</td>
                  <td className={`${cellCls} max-w-[280px] truncate text-muted`}>{comps.length ? comps.map((c) => c.label ?? c.code).join(", ") : "—"}</td>
                  <td className={cellCls}>
                    <Pill>{s.country}</Pill>
                  </td>
                  <td className={numCls}>{s._count.assignments}</td>
                </tr>
              );
            })}
          </DataTable>
        )}
      </Panel>
      <Panel
        title="Who is on which structure"
        actions={<NewAssignmentButton members={data.members} structures={data.structures.filter((s) => s.active).map((s) => ({ id: s.id, name: s.name, payType: s.payType }))} states={[...US_STATE_CODES]} />}
      >
        {current.length === 0 ? (
          <p className="px-5 py-5 text-md text-muted">Nobody is assigned yet. Team members come from Team; each needs a structure and their Form W-4 details.</p>
        ) : (
          <DataTable head={[{ label: "Person" }, { label: "Structure" }, { label: "Pay" }, { label: "From" }, { label: "Until" }, { label: "W-4" }, { label: "State" }, { label: "" }]}>
            {current.map((a) => (
              <tr key={a.id} className={rowCls}>
                <td className={`${cellCls} font-semibold`}>{a.member.name}</td>
                <td className={cellCls}>{a.structure.name}</td>
                <td className={`${cellCls} tabular-nums text-muted`}>
                  {a.annualSalaryCents != null ? `${money(a.annualSalaryCents)} a year` : a.hourlyRateCents != null ? `${money(a.hourlyRateCents)} an hour` : "Structure's"}
                </td>
                <td className={`${cellCls} tabular-nums`}>{fmtDay(a.effectiveFrom)}</td>
                <td className={`${cellCls} tabular-nums text-muted`}>{a.effectiveTo ? fmtDay(a.effectiveTo) : "Open"}</td>
                <td className={cellCls}>
                  {FILING[a.filingStatus] ?? a.filingStatus}
                  {a.w4Step2 ? ", step 2" : ""}
                </td>
                <td className={cellCls}>{a.stateCode ? `${a.stateCode}${a.stateRateBps != null ? ` ${(a.stateRateBps / 100).toFixed(2)}%` : ""}` : "—"}</td>
                <td className={`${cellCls} text-right`}>{a.effectiveTo ? null : <EndAssignmentButton id={a.id} name={a.member.name} />}</td>
              </tr>
            ))}
          </DataTable>
        )}
      </Panel>
    </div>
  );
}
