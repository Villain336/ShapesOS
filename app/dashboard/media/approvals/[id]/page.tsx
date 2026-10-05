// Marketr — Media approval review screen: the exact binding, diffs vs prior
// versions, approver history, OTP confirm, execute. The human reviews the
// binding the executor will enforce byte-for-byte.

import { redirect, notFound } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { mediaStores, safetyTablesReady } from "@/lib/media/db";
import { mediaRoleForWorkspaceRole } from "@/lib/media/safety";
import ApprovalActions from "./_components/ApprovalActions";

export const dynamic = "force-dynamic";

export const metadata = { title: "Approval — Media — ShapesOS" };

function money(cents: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}

export default async function ApprovalPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) redirect("/dashboard");
  const mediaRole = mediaRoleForWorkspaceRole(membership.role);

  if (!(await safetyTablesReady().catch(() => false))) {
    return (
      <div className="p-6 text-sm text-muted">
        Media safety tables are not provisioned yet.
      </div>
    );
  }
  const { id } = await params;
  const { approvals } = mediaStores();
  const approval = await approvals.get(id, workspace.id);
  if (!approval) notFound();
  const events = await approvals.getEvents(id, workspace.id, 500);
  const b = approval.binding;

  return (
    <div className="flex h-full flex-col gap-4 bg-canvas p-4 md:p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-medium text-muted">
            Approval · {approval.type} · {approval.status}
          </p>
          <h1 className="aos-heading mt-1 text-ink">
            {b.platform} — {money(approval.maxSpendCents, approval.currency)} max
          </h1>
          <p className="mt-1 font-mono text-[11px] text-muted">
            binding sha256: {approval.bindingHash}
          </p>
        </div>
        <ApprovalActions approvalId={approval.id} status={approval.status} mediaRole={mediaRole} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-lg border border-line bg-paper p-4">
          <h2 className="mb-3 text-sm font-semibold text-ink">Binding (immutable)</h2>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between gap-4"><dt className="text-muted">Platform</dt><dd className="font-medium text-ink">{b.platform}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-muted">Client ad account</dt><dd className="font-mono text-xs text-ink">{b.clientAdAccountId}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-muted">Deal type</dt><dd className="font-medium text-ink">{b.dealType}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-muted">Max total spend</dt><dd className="font-semibold text-ink">{money(b.maxTotalSpendCents, b.currency)}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-muted">Flight</dt><dd className="text-ink">{b.flightStart.slice(0, 10)} → {b.flightEnd.slice(0, 10)}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-muted">Quote</dt><dd className="font-mono text-xs text-ink">{b.quoteId ?? "—"} {b.quoteExpiresAt ? `(expires ${b.quoteExpiresAt.slice(0, 16)})` : ""}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-muted">Drift tolerance</dt><dd className="text-ink">{b.driftTolerance.pricePct}% price / {b.driftTolerance.spendPct}% spend</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-muted">Cancel terms</dt><dd className="max-w-xs text-right text-ink">{b.cancelTerms}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-muted">Terms version</dt><dd className="font-mono text-xs text-ink">{b.operatorTermsVersion}</dd></div>
          </dl>
          <h3 className="mb-2 mt-4 text-xs font-semibold text-muted">Line items</h3>
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="border-b border-line bg-canvas text-[11px] text-muted">
                  <th className="px-3 py-2 font-medium">Inventory</th>
                  <th className="px-3 py-2 font-medium">Pricing</th>
                  <th className="px-3 py-2 font-medium">Flight</th>
                  <th className="px-3 py-2 font-medium">Max</th>
                </tr>
              </thead>
              <tbody>
                {b.lineItems.map((li, i) => (
                  <tr key={i} className="border-b border-line last:border-0 hover:bg-hover-paper">
                    <td className="px-3 py-2 font-medium text-ink">
                      {li.inventory}
                      <span className="block font-mono text-[10px] font-normal text-muted">
                        creatives {li.creativeHashes.map((h) => h.slice(0, 8)).join(", ")}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-muted">{li.pricingModel}</td>
                    <td className="px-3 py-2 text-[12px] text-muted">{li.flightStart.slice(0, 10)} → {li.flightEnd.slice(0, 10)}</td>
                    <td className="px-3 py-2 font-medium text-ink">{money(li.maxAllowedCents, b.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <div className="space-y-4">
          <section className="rounded-lg border border-line bg-paper p-4">
            <h2 className="mb-3 text-sm font-semibold text-ink">Approver history</h2>
            {approval.approvers.length === 0 ? (
              <p className="text-sm text-muted">No approvals recorded yet.</p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-line">
                <table className="w-full text-left text-[13px]">
                  <thead>
                    <tr className="border-b border-line bg-canvas text-[11px] text-muted">
                      <th className="px-3 py-2 font-medium">Approver</th>
                      <th className="px-3 py-2 font-medium">Method</th>
                      <th className="px-3 py-2 font-medium">Decided</th>
                    </tr>
                  </thead>
                  <tbody>
                    {approval.approvers.map((r, i) => (
                      <tr key={i} className="border-b border-line last:border-0 hover:bg-hover-paper">
                        <td className="px-3 py-2 font-medium text-ink">{r.userId}</td>
                        <td className="px-3 py-2 text-muted">{r.method}</td>
                        <td className="px-3 py-2 text-[12px] text-muted">{r.decidedAt.slice(0, 16)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="mt-3 text-xs text-muted">
              Two-person satisfied: <span className="font-semibold">{approval.twoPersonSatisfied ? "yes" : "no"}</span> ·
              expires {approval.approvalsExpiresAt ? approval.approvalsExpiresAt.toISOString().slice(0, 16) : "—"} (72h window)
            </p>
          </section>

          <section className="rounded-lg border border-line bg-paper p-4">
            <h2 className="mb-3 text-sm font-semibold text-ink">Event log (hash-chained)</h2>
            <div className="max-h-80 overflow-y-auto rounded-lg border border-line">
              <table className="w-full text-left text-[13px]">
                <thead className="sticky top-0">
                  <tr className="border-b border-line bg-canvas text-[11px] text-muted">
                    <th className="px-3 py-2 font-medium">Time</th>
                    <th className="px-3 py-2 font-medium">Action</th>
                    <th className="px-3 py-2 font-medium">Actor</th>
                    <th className="px-3 py-2 font-medium">Hash</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((e) => (
                    <tr key={e.id} className="border-b border-line last:border-0 hover:bg-hover-paper">
                      <td className="px-3 py-2 font-mono text-[11px] text-muted">{e.ts.toISOString().slice(0, 19)}</td>
                      <td className="px-3 py-2 font-semibold text-ink">{e.action}</td>
                      <td className="px-3 py-2 text-[12px] text-muted">{e.actor}</td>
                      <td className="px-3 py-2 font-mono text-[10px] text-muted">{e.eventHash.slice(0, 16)}…</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
