// ShapesOS — Phase 12 (people): /dashboard/ops/payroll/[id] — one pay run:
// totals, every payslip (lines, warnings, PDF) and the lifecycle actions.
// Approve and Post are Tier-3: the first click proposes a Phase 14 approval,
// a person approves it, then the action executes with that approval.
// Admins only.
// Phase 14 (connectors): with Gusto connected, a "Gusto" panel shows the
// steps — sent → submitted in Gusto (taxes computed by Gusto) → posted →
// paid (net pay cleared) — with Send to Gusto (Tier 3) and Sync results.
// Without Gusto the built-in tax tables and the accountant banner remain.

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Check, Minus, ShieldAlert } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { providerSyncFor } from "@/lib/ops/payroll/provider";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { financePageActor } from "@/lib/ops/finance/page";
import { OpsError } from "@/lib/ops/doctype";
import { getPayRunWithSlips, payRunLabel } from "@/lib/ops/payroll/runs";
import { PAYROLL_TAX_DISCLAIMER } from "@/lib/ops/payroll/tax";
import type { PayslipLine } from "@/lib/ops/payroll/rules";
import { DataTable, ErrorLine, FinanceHeader, Panel, Pill, cellCls, fmtDay, money, numCls, rowCls } from "@/components/ops-finance/kit";
import { GustoPayRunActions, PayRunActions } from "@/components/ops-people/PayrollClient";

export const dynamic = "force-dynamic";
export const metadata = { title: "Pay run — ShapesOS", description: "One pay run: payslips, approval and posting." };

const STATE: Record<string, string> = {
  draft: "Draft",
  computed: "Computed — needs approval",
  approved: "Approved — not posted",
  posted: "Posted",
  cancelled: "Cancelled",
};

const hours = (m: number) => `${(m / 60).toFixed(2)} h`;

export default async function PayRunPage({ params, searchParams }: PageProps<"/dashboard/ops/payroll/[id]">) {
  const actor = await financePageActor();
  if (!actor.isAdmin) redirect("/dashboard/ops/payroll");
  const { id } = await params;
  const sp = await searchParams;
  let data;
  try {
    data = await withWorkspaceScope(actor.workspaceId, (tx) => getPayRunWithSlips(tx, actor.workspaceId, id));
  } catch (err) {
    if (err instanceof OpsError && err.status === 404) notFound();
    throw err;
  }
  const { run, payslips } = data;
  // Phase 14 (connectors): Gusto state (no network on page load).
  const [gustoConnected, sync] = await Promise.all([
    prisma.connectorConnection.count({ where: { workspaceId: actor.workspaceId, connectorKey: "gusto", status: "active" } }).then((n) => n > 0),
    withWorkspaceScope(actor.workspaceId, (tx) => providerSyncFor(tx, actor.workspaceId, id)),
  ]);
  const gusto = sync?.provider === "gusto" ? sync : null;
  const byGusto = gusto?.status === "synced" || gusto?.status === "paid";
  const gustoSummary = (gusto?.summary ?? {}) as { checkDate?: string | null; skipped?: Array<{ memberName: string; reason: string }>; warnings?: string[]; sent?: unknown[]; salaried?: unknown[]; lastSync?: { discrepancies?: string[]; warnings?: string[] } };
  const stale = gusto?.status === "sent" && gusto.sentDigest !== run.computeDigest;
  const gustoNotes = [...(gustoSummary.skipped ?? []).map((x) => `${x.memberName}: ${x.reason}`), ...(gustoSummary.warnings ?? []), ...(gustoSummary.lastSync?.warnings ?? []), ...(gustoSummary.lastSync?.discrepancies ?? []).map((d) => `Differs from Gusto — ${d}`)];
  const label = payRunLabel(run);
  const preTax = payslips.reduce((s, p) => s + p.preTaxDeductionCents, 0);
  const postTax = payslips.reduce((s, p) => s + p.postTaxDeductionCents, 0);
  const contrib = payslips.reduce((s, p) => s + p.employerContribCents, 0);
  const summary = `${label}: ${payslips.length} payslip(s) for ${fmtDay(run.periodStart)} – ${fmtDay(run.periodEnd)}, gross ${money(run.grossCents)}, net pay ${money(run.netCents)}, employer taxes ${money(run.employerTaxCents)}`;
  const error = typeof sp.error === "string" ? sp.error : null;

  return (
    <div className="flex flex-col gap-6">
      <FinanceHeader
        title={`Pay run ${label}`}
        description={
          <>
            {fmtDay(run.periodStart)} – {fmtDay(run.periodEnd)} · pay date {fmtDay(run.payDate)} · <Pill>{STATE[run.status] ?? run.status}</Pill>
          </>
        }
        actions={<PayRunActions id={run.id} label={label} status={run.status} summary={summary} />}
      />
      {error ? <ErrorLine>{error}</ErrorLine> : null}
      {byGusto ? (
        <div className="flex items-start gap-3 rounded-md bg-paper px-4 py-3 shadow-hairline">
          <Check size={18} className="mt-0.5 shrink-0 text-ink" aria-hidden />
          <p className="text-md">
            <span className="font-semibold">Taxes computed by Gusto. </span>
            <span className="text-muted">The payslips hold the taxes, deductions and net pay from Gusto&apos;s processed payroll.</span>
          </p>
        </div>
      ) : (
        <div className="flex items-start gap-3 rounded-md bg-paper px-4 py-3 shadow-hairline">
          <ShieldAlert size={18} className="mt-0.5 shrink-0 text-ink" aria-hidden />
          <p className="text-md">
            <span className="font-semibold">Verify with your accountant. </span>
            <span className="text-muted">{PAYROLL_TAX_DISCLAIMER}</span>
          </p>
        </div>
      )}
      {gustoConnected || gusto ? (
        <Panel title="Gusto">
          <ol className="flex flex-col gap-2 px-5 py-4 text-md">
            {[
              { done: !!gusto, label: gusto ? `Sent to Gusto ${fmtDay(gusto.sentAt)}${gustoSummary.checkDate ? ` · check date ${gustoSummary.checkDate}` : ""}${stale ? " · out of date: recomputed since — send again" : ""}` : "Send the computed run's hours to Gusto's open payroll for this period" },
              { done: byGusto, label: byGusto ? `Submitted in Gusto — taxes and net pay synced ${fmtDay(gusto?.syncedAt ?? null)}` : "Review and submit the payroll in Gusto, then sync the results" },
              { done: run.status === "posted", label: run.status === "posted" ? `Posted to the books ${fmtDay(run.postedAt)}` : "Approve and post the run with Gusto's figures" },
              { done: gusto?.status === "paid", label: gusto?.status === "paid" ? (gusto.paymentEntryId ? `Paid by Gusto — Net pay payable cleared (entry ${gusto.paymentEntryId.slice(0, 14)})` : "Paid by Gusto — net pay is cleared once the run is posted") : "Gusto pays on the check date; sync again to clear Net pay payable" },
            ].map((step, i) => (
              <li key={i} className="flex items-start gap-2">
                {step.done ? <Check size={16} className="mt-0.5 shrink-0 text-ink" aria-label="done" /> : <Minus size={16} className="mt-0.5 shrink-0 text-subtle" aria-label="not yet" />}
                <span className={step.done ? "text-ink" : "text-muted"}>{step.label}</span>
              </li>
            ))}
          </ol>
          {gustoNotes.length ? (
            <ul className="flex flex-col gap-1 border-t border-line px-5 py-3 text-sm text-muted">
              {gustoNotes.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          ) : null}
          {gustoConnected ? (
            <div className="border-t border-line px-5 py-3">
              <GustoPayRunActions id={run.id} label={label} status={run.status} gustoStatus={gusto?.status ?? null} stale={stale} summary={summary} />
            </div>
          ) : null}
        </Panel>
      ) : null}
      <Panel title="Totals">
        <dl className="grid grid-cols-2 gap-x-8 gap-y-3 px-5 py-4 text-md sm:grid-cols-4">
          {[
            ["Gross pay", run.grossCents],
            ["Pre-tax deductions", preTax],
            ["Taxes withheld", run.employeeTaxCents],
            ["Post-tax deductions", postTax],
            ["Net pay owed", run.netCents],
            ["Employer taxes", run.employerTaxCents],
            ["Employer contributions", contrib],
            ["Total cost", run.grossCents + run.employerTaxCents + contrib],
          ].map(([k, v]) => (
            <div key={String(k)}>
              <dt className="text-xs font-semibold text-muted">{k}</dt>
              <dd className="tabular-nums text-base font-semibold">{money(Number(v))}</dd>
            </div>
          ))}
        </dl>
        <p className="border-t border-line px-5 py-3 text-sm text-muted">
          {run.status === "posted" && run.journalEntryId ? (
            <>
              Posted {fmtDay(run.postedAt)} as journal entry{" "}
              <Link className="aos-mono underline" href={`/dashboard/ops/accounting/journal?entry=${run.journalEntryId}`}>
                {run.journalEntryId.slice(0, 14)}
              </Link>
              . Net pay stays in Net pay payable until you pay it outside ShapesOS.
            </>
          ) : run.status === "approved" ? (
            `Approved ${fmtDay(run.approvedAt)}. Posting writes one balanced entry: wages, employer taxes and contributions against the tax, deduction and net-pay liabilities.`
          ) : run.status === "computed" ? (
            run.approvalId ? `Approval ${run.approvalId.slice(0, 10)}… requested — approve it here or in the Actions queue.` : "Review the payslips, then request approval."
          ) : null}
        </p>
      </Panel>
      <Panel title={`Payslips (${payslips.length})`}>
        {payslips.length === 0 ? (
          <p className="px-5 py-5 text-md text-muted">Compute the run to create payslips.</p>
        ) : (
          <DataTable
            minWidth={980}
            head={[{ label: "Person" }, { label: "Structure" }, { label: "Hours" }, { label: "Gross", align: "right" }, { label: "Deductions", align: "right" }, { label: "Taxes withheld", align: "right" }, { label: "Net pay", align: "right" }, { label: "Employer cost", align: "right" }, { label: "" }]}
          >
            {payslips.map((p) => {
              const lines = (p.lines as unknown as PayslipLine[]) ?? [];
              const warnings = Array.isArray(p.warnings) ? (p.warnings as string[]) : [];
              return (
                <tr key={p.id} className={`${rowCls} align-top`}>
                  <td className={`${cellCls} font-semibold`}>
                    <details>
                      <summary className="cursor-pointer">{p.memberName}</summary>
                      <ul className="mt-2 flex flex-col gap-0.5 text-sm font-normal">
                        {lines.map((l, i) => (
                          <li key={i} className="flex justify-between gap-4">
                            <span>
                              {l.label}
                              {l.detail ? <span className="text-muted"> · {l.detail}</span> : null}
                            </span>
                            <span className="tabular-nums">{money(l.amountCents)}</span>
                          </li>
                        ))}
                      </ul>
                    </details>
                    {warnings.length ? (
                      <ul className="mt-1 flex flex-col gap-0.5 text-sm font-normal text-muted">
                        {warnings.map((w, i) => (
                          <li key={i}>{w}</li>
                        ))}
                      </ul>
                    ) : null}
                  </td>
                  <td className={cellCls}>{p.structureName}</td>
                  <td className={`${cellCls} tabular-nums text-muted`}>
                    {p.payType === "hourly" ? `${hours(p.regularMinutes)}${p.overtimeMinutes ? ` + ${hours(p.overtimeMinutes)} OT` : ""}` : "Salary"}
                  </td>
                  <td className={numCls}>{money(p.grossCents)}</td>
                  <td className={numCls}>{money(p.preTaxDeductionCents + p.postTaxDeductionCents)}</td>
                  <td className={numCls}>{money(p.employeeTaxCents)}</td>
                  <td className={`${numCls} font-semibold`}>{money(p.netCents)}</td>
                  <td className={numCls}>{money(p.employerTaxCents + p.employerContribCents)}</td>
                  <td className={`${cellCls} text-right`}>
                    <a className="text-sm font-semibold underline" href={`/api/ops/payslips/${p.id}/pdf`} target="_blank" rel="noreferrer">
                      PDF
                    </a>
                  </td>
                </tr>
              );
            })}
          </DataTable>
        )}
      </Panel>
    </div>
  );
}
