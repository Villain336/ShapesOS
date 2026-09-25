// Marketr — Media command center (Phase 5 SAFETY).
// Pool utilization, pending approvals, active buys, kill-switch status,
// and the fenced emergency stop.

import { redirect } from "next/navigation";
import Link from "next/link";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { mediaStores, safetyTablesReady } from "@/lib/media/db";
import { mediaRoleForWorkspaceRole } from "@/lib/media/safety";
import EmergencyStopButton from "./_components/EmergencyStopButton";
import SeedRulesButton from "./_components/SeedRulesButton";
import { Badge } from "@/components/vault/shadcn/badge";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Media — Marketr",
  description: "Media buying command center: budget pools, approvals, kill switches.",
};

function money(cents: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}

export default async function MediaPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) redirect("/dashboard");
  const mediaRole = mediaRoleForWorkspaceRole(membership.role);

  const ready = await safetyTablesReady().catch(() => false);
  let pools: Awaited<ReturnType<ReturnType<typeof mediaStores>["pools"]["list"]>> = [];
  let pending: Awaited<ReturnType<ReturnType<typeof mediaStores>["approvals"]["list"]>> = [];
  let rules: Awaited<ReturnType<ReturnType<typeof mediaStores>["killRules"]["list"]>> = [];
  let buys: Awaited<ReturnType<ReturnType<typeof mediaStores>["buys"]["list"]>> = [];
  if (ready) {
    const stores = mediaStores();
    [pools, pending, rules, buys] = await Promise.all([
      stores.pools.list(workspace.id).catch(() => []),
      stores.approvals.list(workspace.id, "pending", 50).catch(() => []),
      stores.killRules.list(workspace.id).catch(() => []),
      stores.buys.list(workspace.id, 50).catch(() => []),
    ]);
  }

  return (
    <div className="flex h-full flex-col gap-6 bg-[#FAFAF7] p-4 md:p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-stone-900">Media</h1>
          <p className="mt-0.5 max-w-2xl text-[13px] text-stone-500">
            Supervised-always buying rails: budget pools, per-buy approval bindings, and kill
            switches. Autopilot never buys media — enforced structurally, not by config. Guards
            against the €7,937/day failure class: no automation can compound spend without a
            human-approved cap at ≥2 independent layers.
          </p>
        </div>
        <EmergencyStopButton mediaRole={mediaRole} />
      </div>

      {!ready && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          Media safety tables are not provisioned yet — merge{" "}
          <code className="font-mono">prisma/fragments/phase5-safety.prisma</code> and migrate.
          This page renders in read-only preview until then.
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Pools */}
        <section className="rounded-xl border border-stone-200 bg-white p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-stone-900">Budget pools</h2>
            <Link href="/dashboard/media/pools" className="text-xs font-medium text-stone-500 hover:text-stone-900">
              View all →
            </Link>
          </div>
          {pools.length === 0 ? (
            <p className="text-sm text-stone-500">
              No pools yet. A pool is a cap with a ledger — Marketr never holds client money.
            </p>
          ) : (
            <ul className="space-y-2">
              {pools.slice(0, 5).map((p) => {
                const util = p.capCents > 0 ? ((p.capCents - p.remainingCents) / p.capCents) * 100 : 100;
                return (
                  <li key={p.id}>
                    <Link href={`/dashboard/media/pools/${p.id}`} className="block rounded-lg border border-stone-100 p-3 hover:border-stone-300">
                      <div className="flex items-center justify-between text-sm">
                        <span className="font-medium text-stone-900">{p.name}</span>
                        <span className="text-xs text-stone-500">
                          {money(p.remainingCents, p.currency)} left · {p.status}
                        </span>
                      </div>
                      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-stone-100">
                        <div
                          className={`h-full rounded-full ${util >= 90 ? "bg-red-500" : util >= 75 ? "bg-amber-500" : "bg-emerald-500"}`}
                          style={{ width: `${Math.min(100, util).toFixed(1)}%` }}
                        />
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* Pending approvals */}
        <section className="rounded-xl border border-stone-200 bg-white p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-stone-900">Pending approvals</h2>
            <span className="text-xs text-stone-500">
              {mediaRole === "owner" ? "You can approve" : "Buyers propose — owners approve"}
            </span>
          </div>
          {pending.length === 0 ? (
            <p className="text-sm text-stone-500">Nothing awaiting approval.</p>
          ) : (
            <ul className="space-y-2">
              {pending.slice(0, 5).map((a) => (
                <li key={a.id}>
                  <Link href={`/dashboard/media/approvals/${a.id}`} className="block rounded-lg border border-stone-100 p-3 hover:border-stone-300">
                    <div className="flex items-center justify-between text-sm">
                      <span className="font-medium text-stone-900">{a.binding.platform} · {a.type}</span>
                      <span className="text-xs font-semibold text-stone-900">{money(a.maxSpendCents, a.currency)}</span>
                    </div>
                    <p className="mt-0.5 font-mono text-[11px] text-stone-400">binding {a.bindingHash.slice(0, 16)}…</p>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Kill switches */}
        <section className="rounded-xl border border-stone-200 bg-white p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-stone-900">Kill switches</h2>
            <SeedRulesButton mediaRole={mediaRole} hasRules={rules.length > 0} />
          </div>
          {rules.length === 0 ? (
            <p className="text-sm text-stone-500">
              No sweeper rules yet. Seed the default v1 pack (stop-loss, test-cap kill, spend-anomaly
              alert, pool-exhausted pause-all, creative-fatigue) — it ships enabled.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {rules.map((r) => (
                <li key={r.id} className="flex items-center justify-between rounded-lg border border-stone-100 px-3 py-2 text-sm">
                  <span className="text-stone-800">{r.name}</span>
                  <span className="flex items-center gap-1.5">
                    <Badge variant={r.enabled ? "default" : "secondary"}>{r.enabled ? "armed" : "off"}</Badge>
                    <span className="text-[11px] text-stone-500">{r.action}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Active buys */}
        <section className="rounded-xl border border-stone-200 bg-white p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-stone-900">Executed buys</h2>
            <span className="text-xs text-stone-500">{buys.length} total</span>
          </div>
          {buys.length === 0 ? (
            <p className="text-sm text-stone-500">No executed buys yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {buys.slice(0, 5).map((b) => (
                <li key={b.id} className="flex items-center justify-between rounded-lg border border-stone-100 px-3 py-2 text-sm">
                  <span className="text-stone-800">{b.platform}</span>
                  <span className="text-xs text-stone-500">
                    {b.status} · {b.actualSpendCents != null ? money(b.actualSpendCents) : "—"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
