// Marketr — Pool detail: caps, encumbrance ledger, utilization alerts,
// virtual-card status, freeze control.

import { redirect, notFound } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { mediaStores, safetyTablesReady } from "@/lib/media/db";
import { mediaRoleForWorkspaceRole } from "@/lib/media/safety";
import { poolUtilization } from "@/lib/media/pools";
import PoolControls from "./_components/PoolControls";
import { Badge } from "@/components/vault/shadcn/badge";

export const dynamic = "force-dynamic";
export const metadata = { title: "Pool — Media — Marketr" };

function money(cents: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}

export default async function PoolPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) redirect("/dashboard");
  const mediaRole = mediaRoleForWorkspaceRole(membership.role);

  if (!(await safetyTablesReady().catch(() => false))) {
    return <div className="p-6 text-sm text-stone-600">Media safety tables are not provisioned yet.</div>;
  }
  const { id } = await params;
  const { pools } = mediaStores();
  const pool = await pools.get(id, workspace.id);
  if (!pool) notFound();
  const txs = await pools.listTxs(id, workspace.id, 200);
  const util = poolUtilization(pool) * 100;

  return (
    <div className="flex h-full flex-col gap-6 bg-[#FAFAF7] p-4 md:p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-stone-400">
            Budget pool · {pool.period} · {pool.status}
          </p>
          <h1 className="mt-1 text-xl font-bold tracking-tight text-stone-900">{pool.name}</h1>
          <p className="mt-1 text-[13px] text-stone-500">
            Cap {money(pool.capCents, pool.currency)} · allowlist: {pool.platformAllowlist.join(", ")}
          </p>
        </div>
        <PoolControls poolId={pool.id} status={pool.status} mediaRole={mediaRole} hasCard={!!pool.virtualCardRef} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <section className="rounded-xl border border-stone-200 bg-white p-4">
          <h2 className="mb-2 text-sm font-semibold text-stone-900">Utilization</h2>
          <div className="h-2 overflow-hidden rounded-full bg-stone-100">
            <div
              className={`h-full rounded-full ${util >= 90 ? "bg-red-500" : util >= 75 ? "bg-amber-500" : "bg-emerald-500"}`}
              style={{ width: `${Math.min(100, util).toFixed(1)}%` }}
            />
          </div>
          <dl className="mt-3 space-y-1.5 text-sm">
            <div className="flex justify-between"><dt className="text-stone-500">Remaining</dt><dd className="font-semibold text-stone-900">{money(pool.remainingCents, pool.currency)}</dd></div>
            <div className="flex justify-between"><dt className="text-stone-500">Encumbered</dt><dd className="text-stone-900">{money(pool.encumberedCents, pool.currency)}</dd></div>
            <div className="flex justify-between"><dt className="text-stone-500">Alerts at</dt><dd className="text-stone-900">{pool.alertThresholds.join(" / ")}%</dd></div>
          </dl>
        </section>

        <section className="rounded-xl border border-stone-200 bg-white p-4">
          <h2 className="mb-2 text-sm font-semibold text-stone-900">Virtual card (money-layer backstop)</h2>
          <dl className="space-y-1.5 text-sm">
            <div className="flex justify-between"><dt className="text-stone-500">Provider</dt><dd className="text-stone-900">{pool.cardProvider}</dd></div>
            <div className="flex justify-between"><dt className="text-stone-500">Ref</dt><dd className="font-mono text-xs text-stone-900">{pool.virtualCardRef ?? "none attached"}</dd></div>
            <div className="flex justify-between"><dt className="text-stone-500">Limit</dt><dd className="text-stone-900">= pool cap ({money(pool.capCents, pool.currency)})</dd></div>
          </dl>
          <p className="mt-2 text-xs text-stone-500">
            Issued on the client&apos;s own account. Card declines survive Marketr software bugs —
            the layer that kills the €7,937/day class. Only the ref is stored; never a PAN.
          </p>
        </section>

        <section className="rounded-xl border border-stone-200 bg-white p-4">
          <h2 className="mb-2 text-sm font-semibold text-stone-900">Guardrails</h2>
          <ul className="space-y-1.5 text-sm text-stone-700">
            <li>· Over-encumbrance rejected at the service layer</li>
            <li>· Expiry / revocation releases encumbrance</li>
            <li>· One ad account per client (no cross-client contamination)</li>
            <li>· Google has no true account cap — card + sweeper are the ceiling</li>
          </ul>
        </section>
      </div>

      <section className="rounded-xl border border-stone-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold text-stone-900">Encumbrance ledger</h2>
        {txs.length === 0 ? (
          <p className="text-sm text-stone-500">No ledger entries yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-stone-200 text-xs uppercase tracking-wide text-stone-400">
                  <th className="py-2 pr-4">Time</th>
                  <th className="py-2 pr-4">Kind</th>
                  <th className="py-2 pr-4">Amount</th>
                  <th className="py-2 pr-4">Remaining</th>
                  <th className="py-2 pr-4">Encumbered</th>
                  <th className="py-2 pr-4">Actor</th>
                  <th className="py-2">Note</th>
                </tr>
              </thead>
              <tbody>
                {txs.map((t) => (
                  <tr key={t.id} className="border-b border-stone-100 last:border-0">
                    <td className="py-2 pr-4 font-mono text-xs text-stone-500">{t.ts.toISOString().slice(0, 19)}</td>
                    <td className="py-2 pr-4"><Badge variant="secondary">{t.kind}</Badge></td>
                    <td className="py-2 pr-4 font-medium">{money(t.amountCents, pool.currency)}</td>
                    <td className="py-2 pr-4">{money(t.runningRemainingCents, pool.currency)}</td>
                    <td className="py-2 pr-4">{money(t.runningEncumberedCents, pool.currency)}</td>
                    <td className="py-2 pr-4 font-mono text-xs text-stone-500">{t.actor.slice(0, 12)}</td>
                    <td className="py-2 text-xs text-stone-500">{t.note ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
