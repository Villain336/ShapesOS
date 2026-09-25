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

export const metadata = { title: "Approval — Media — Marketr" };

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
      <div className="p-6 text-sm text-stone-600">
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
    <div className="flex h-full flex-col gap-6 bg-[#FAFAF7] p-4 md:p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-stone-400">
            Approval · {approval.type} · {approval.status}
          </p>
          <h1 className="mt-1 text-xl font-bold tracking-tight text-stone-900">
            {b.platform} — {money(approval.maxSpendCents, approval.currency)} max
          </h1>
          <p className="mt-1 font-mono text-[11px] text-stone-400">
            binding sha256: {approval.bindingHash}
          </p>
        </div>
        <ApprovalActions approvalId={approval.id} status={approval.status} mediaRole={mediaRole} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-xl border border-stone-200 bg-white p-4">
          <h2 className="mb-3 text-sm font-semibold text-stone-900">Binding (immutable)</h2>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between gap-4"><dt className="text-stone-500">Platform</dt><dd className="font-medium text-stone-900">{b.platform}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-stone-500">Client ad account</dt><dd className="font-mono text-xs text-stone-900">{b.clientAdAccountId}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-stone-500">Deal type</dt><dd className="font-medium text-stone-900">{b.dealType}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-stone-500">Max total spend</dt><dd className="font-semibold text-stone-900">{money(b.maxTotalSpendCents, b.currency)}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-stone-500">Flight</dt><dd className="text-stone-900">{b.flightStart.slice(0, 10)} → {b.flightEnd.slice(0, 10)}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-stone-500">Quote</dt><dd className="font-mono text-xs text-stone-900">{b.quoteId ?? "—"} {b.quoteExpiresAt ? `(expires ${b.quoteExpiresAt.slice(0, 16)})` : ""}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-stone-500">Drift tolerance</dt><dd className="text-stone-900">{b.driftTolerance.pricePct}% price / {b.driftTolerance.spendPct}% spend</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-stone-500">Cancel terms</dt><dd className="max-w-xs text-right text-stone-900">{b.cancelTerms}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-stone-500">Terms version</dt><dd className="font-mono text-xs text-stone-900">{b.operatorTermsVersion}</dd></div>
          </dl>
          <h3 className="mb-2 mt-4 text-xs font-semibold uppercase tracking-wide text-stone-400">Line items</h3>
          <ul className="space-y-2">
            {b.lineItems.map((li, i) => (
              <li key={i} className="rounded-lg border border-stone-100 p-3 text-sm">
                <div className="flex justify-between">
                  <span className="font-medium text-stone-900">{li.inventory}</span>
                  <span className="font-semibold">{money(li.maxAllowedCents, b.currency)}</span>
                </div>
                <p className="mt-0.5 text-xs text-stone-500">{li.pricingModel} · {li.flightStart.slice(0, 10)} → {li.flightEnd.slice(0, 10)}</p>
                <p className="mt-1 font-mono text-[10px] text-stone-400">
                  creatives: {li.creativeIds.join(", ")} · hashes {li.creativeHashes.map((h) => h.slice(0, 8)).join(", ")}
                </p>
              </li>
            ))}
          </ul>
        </section>

        <div className="space-y-4">
          <section className="rounded-xl border border-stone-200 bg-white p-4">
            <h2 className="mb-3 text-sm font-semibold text-stone-900">Approver history</h2>
            {approval.approvers.length === 0 ? (
              <p className="text-sm text-stone-500">No approvals recorded yet.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {approval.approvers.map((r, i) => (
                  <li key={i} className="rounded-lg border border-stone-100 p-3">
                    <div className="flex justify-between">
                      <span className="font-medium text-stone-900">{r.userId}</span>
                      <span className="text-xs text-stone-500">{r.method} · {r.decidedAt.slice(0, 16)}</span>
                    </div>
                    <p className="mt-1 font-mono text-[10px] text-stone-400">receipt {r.receipt.slice(0, 24)}…</p>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 text-xs text-stone-500">
              Two-person satisfied: <span className="font-semibold">{approval.twoPersonSatisfied ? "yes" : "no"}</span> ·
              expires {approval.approvalsExpiresAt ? approval.approvalsExpiresAt.toISOString().slice(0, 16) : "—"} (72h window)
            </p>
          </section>

          <section className="rounded-xl border border-stone-200 bg-white p-4">
            <h2 className="mb-3 text-sm font-semibold text-stone-900">Event log (hash-chained)</h2>
            <ul className="max-h-80 space-y-1.5 overflow-y-auto text-xs">
              {events.map((e) => (
                <li key={e.id} className="rounded-md bg-stone-50 px-2.5 py-1.5">
                  <span className="font-mono text-stone-400">{e.ts.toISOString().slice(0, 19)}</span>{" "}
                  <span className="font-semibold text-stone-800">{e.action}</span>{" "}
                  <span className="text-stone-500">by {e.actor}</span>
                  <span className="block font-mono text-[10px] text-stone-400">{e.eventHash.slice(0, 24)}…</span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}
