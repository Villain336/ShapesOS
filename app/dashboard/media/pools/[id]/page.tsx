// Marketr — Pool detail: caps, encumbrance ledger, utilization alerts,
// virtual-card status, freeze control.

import { redirect, notFound } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { mediaStores, safetyTablesReady } from "@/lib/media/db";
import { mediaRoleForWorkspaceRole } from "@/lib/media/safety";
import { poolUtilization } from "@/lib/media/pools";
import PoolControls from "./_components/PoolControls";

const chip =
  "inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-tight bg-canvas text-muted border-line";

export const dynamic = "force-dynamic";
export const metadata = { title: "Pool — Media — ShapesOS" };

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
    return <div className="p-6 text-sm text-muted">Media safety tables are not provisioned yet.</div>;
  }
  const { id } = await params;
  const { pools } = mediaStores();
  const pool = await pools.get(id, workspace.id);
  if (!pool) notFound();
  const txs = await pools.listTxs(id, workspace.id, 200);
  const util = poolUtilization(pool) * 100;

  return (
    <div className="flex h-full flex-col gap-4 bg-[#FAFAF7] p-4 md:p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-subtle">
            Budget pool · {pool.period} · {pool.status}
          </p>
          <h1 className="aos-heading mt-1 text-ink">{pool.name}</h1>
          <p className="mt-1 text-[13px] text-muted">
            Cap {money(pool.capCents, pool.currency)} · allowlist: {pool.platformAllowlist.join(", ")}
          </p>
        </div>
        <PoolControls poolId={pool.id} status={pool.status} mediaRole={mediaRole} hasCard={!!pool.virtualCardRef} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <section className="rounded-lg border border-line bg-paper p-4">
          <h2 className="mb-2 text-sm font-semibold text-ink">Utilization</h2>
          <div className="h-2 overflow-hidden rounded-full bg-canvas">
            <div
              className={`h-full rounded-full ${util >= 90 ? "bg-ink" : util >= 75 ? "bg-ink" : "bg-ink"}`}
              style={{ width: `${Math.min(100, util).toFixed(1)}%` }}
            />
          </div>
          <dl className="mt-3 space-y-1.5 text-sm">
            <div className="flex justify-between"><dt className="text-muted">Remaining</dt><dd className="font-semibold text-ink">{money(pool.remainingCents, pool.currency)}</dd></div>
            <div className="flex justify-between"><dt className="text-muted">Encumbered</dt><dd className="text-ink">{money(pool.encumberedCents, pool.currency)}</dd></div>
            <div className="flex justify-between"><dt className="text-muted">Alerts at</dt><dd className="text-ink">{pool.alertThresholds.join(" / ")}%</dd></div>
          </dl>
        </section>

        <section className="rounded-lg border border-line bg-paper p-4">
          <h2 className="mb-2 text-sm font-semibold text-ink">Virtual card (money-layer backstop)</h2>
          <dl className="space-y-1.5 text-sm">
            <div className="flex justify-between"><dt className="text-muted">Provider</dt><dd className="text-ink">{pool.cardProvider}</dd></div>
            <div className="flex justify-between"><dt className="text-muted">Ref</dt><dd className="font-mono text-xs text-ink">{pool.virtualCardRef ?? "none attached"}</dd></div>
            <div className="flex justify-between"><dt className="text-muted">Limit</dt><dd className="text-ink">= pool cap ({money(pool.capCents, pool.currency)})</dd></div>
          </dl>
          <p className="mt-2 text-xs text-muted">
            Issued on the client&apos;s own account. Card declines survive ShapesOS software bugs —
            the layer that kills the €7,937/day class. Only the ref is stored; never a PAN.
          </p>
        </section>

        <section className="rounded-lg border border-line bg-paper p-4">
          <h2 className="mb-2 text-sm font-semibold text-ink">Guardrails</h2>
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted">
            <li>Over-encumbrance rejected at the service layer</li>
            <li>Expiry / revocation releases encumbrance</li>
            <li>One ad account per client (no cross-client contamination)</li>
            <li>Google has no true account cap — card + sweeper are the ceiling</li>
          </ul>
        </section>
      </div>

      <section className="rounded-lg border border-line bg-paper p-4">
        <h2 className="mb-3 text-sm font-semibold text-ink">Encumbrance ledger</h2>
        {txs.length === 0 ? (
          <p className="text-sm text-muted">No ledger entries yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-line bg-canvas text-[11px] uppercase tracking-wide text-muted">
                  <th className="px-3 py-2 font-medium">Time</th>
                  <th className="px-3 py-2 font-medium">Kind</th>
                  <th className="px-3 py-2 font-medium">Amount</th>
                  <th className="px-3 py-2 font-medium">Remaining</th>
                  <th className="px-3 py-2 font-medium">Encumbered</th>
                  <th className="px-3 py-2 font-medium">Actor</th>
                  <th className="py-2">Note</th>
                </tr>
              </thead>
              <tbody>
                {txs.map((t) => (
                  <tr key={t.id} className="border-b border-line last:border-0 hover:bg-hover-paper">
                    <td className="px-3 py-2 font-mono text-xs text-muted">{t.ts.toISOString().slice(0, 19)}</td>
                    <td className="px-3 py-2"><span className={chip}>{t.kind}</span></td>
                    <td className="px-3 py-2 font-medium">{money(t.amountCents, pool.currency)}</td>
                    <td className="px-3 py-2">{money(t.runningRemainingCents, pool.currency)}</td>
                    <td className="px-3 py-2">{money(t.runningEncumberedCents, pool.currency)}</td>
                    <td className="px-3 py-2 font-mono text-xs text-muted">{t.actor.slice(0, 12)}</td>
                    <td className="px-3 py-2 text-xs text-muted">{t.note ?? "—"}</td>
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
