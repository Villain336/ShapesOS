// Marketr — Media command center (Phase 5 SAFETY).
// Pool utilization, pending approvals, active buys, kill-switch status,
// and the fenced emergency stop.

import { TriangleAlert } from "lucide-react";
import { redirect } from "next/navigation";
import Link from "next/link";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { mediaStores, safetyTablesReady } from "@/lib/media/db";
import { mediaRoleForWorkspaceRole } from "@/lib/media/safety";
import EmergencyStopButton from "./_components/EmergencyStopButton";
import SeedRulesButton from "./_components/SeedRulesButton";

const chip =
  "inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-tight";
const chipSlate = `${chip} bg-canvas text-muted border-line`;
const chipGreen = `${chip} bg-canvas text-muted border-line`;
const chipRed = `${chip} bg-canvas text-muted border-line`;

function poolStatusTone(status: string): string {
  return status === "active" ? chipGreen : status === "frozen" ? chipRed : chipSlate;
}

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Media — ShapesOS",
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
    <div className="flex h-full flex-col gap-4 bg-canvas p-4 md:p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="aos-heading text-ink">Media</h1>
          <p className="mt-0.5 max-w-2xl text-[13px] text-muted">
            Supervised-always buying rails: budget pools, per-buy approval bindings, and kill
            switches. Autopilot never buys media — enforced structurally, not by config. Guards
            against the €7,937/day failure class: no automation can compound spend without a
            human-approved cap at ≥2 independent layers.
          </p>
        </div>
        <EmergencyStopButton mediaRole={mediaRole} />
      </div>

      {!ready && (
        <div className="rounded-lg bg-needs-tint p-4 text-sm text-ink shadow-hairline">
          <p className="flex items-start gap-2 font-semibold"><TriangleAlert size={16} className="mt-0.5 shrink-0" />Media safety tables are not provisioned yet</p>
          <p className="mt-1 text-[13px]">Merge <code className="font-mono">prisma/fragments/phase5-safety.prisma</code> and migrate. This page renders in read-only preview until then.</p>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Phase 18: Advertising — one home for paid platforms */}
        <section className="rounded-lg border border-line bg-paper p-4 lg:col-span-2">
          <div className="mb-1 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ink">Advertising <span className="ml-1 rounded-full border border-line bg-canvas px-1.5 py-0.5 text-[10px] font-medium text-muted">Phase 18</span></h2>
            <Link href="/dashboard/media/advertising" className="text-xs font-medium text-muted hover:text-ink">
              Open →
            </Link>
          </div>
          <p className="text-sm text-muted">
            Buy everywhere, approve everything — Amazon Ads, StackAdapt, Walmart Connect, and Spotify behind one propose → approve spend gate.
          </p>
        </section>
        {/* Pools */}
        <section className="rounded-lg border border-line bg-paper p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ink">Budget pools</h2>
            <Link href="/dashboard/media/pools" className="text-xs font-medium text-muted hover:text-ink">
              View all →
            </Link>
          </div>
          {pools.length === 0 ? (
            <p className="text-sm text-muted">
              No pools yet. A pool is a cap with a ledger — ShapesOS never holds client money.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[13px]">
                <thead>
                  <tr className="border-b border-line bg-canvas text-[11px] text-muted">
                    <th className="px-3 py-2 font-medium">Pool</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                    <th className="px-3 py-2 font-medium">Remaining</th>
                    <th className="px-3 py-2 font-medium">Utilization</th>
                  </tr>
                </thead>
                <tbody>
                  {pools.slice(0, 5).map((p) => {
                    const util = p.capCents > 0 ? ((p.capCents - p.remainingCents) / p.capCents) * 100 : 100;
                    return (
                      <tr key={p.id} className="border-b border-line last:border-0 hover:bg-hover-paper">
                        <td className="px-3 py-2">
                          <Link href={`/dashboard/media/pools/${p.id}`} className="font-medium text-ink hover:underline">
                            {p.name}
                          </Link>
                        </td>
                        <td className="px-3 py-2"><span className={poolStatusTone(p.status)}>{p.status}</span></td>
                        <td className="px-3 py-2 font-medium text-ink">{money(p.remainingCents, p.currency)}</td>
                        <td className="px-3 py-2">
                          <span className="inline-flex w-28 items-center gap-2">
                            <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-canvas">
                              <span
                                className={`block h-full rounded-full ${util >= 90 ? "bg-ink" : util >= 75 ? "bg-ink" : "bg-ink"}`}
                                style={{ width: `${Math.min(100, util).toFixed(1)}%` }}
                              />
                            </span>
                            <span className="text-[11px] text-muted">{util.toFixed(0)}%</span>
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Pending approvals */}
        <section className="rounded-lg border border-line bg-paper p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ink">Pending approvals</h2>
            <span className="text-xs text-muted">
              {mediaRole === "owner" ? "You can approve" : "Buyers propose — owners approve"}
            </span>
          </div>
          {pending.length === 0 ? (
            <p className="text-sm text-muted">Nothing awaiting approval.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[13px]">
                <thead>
                  <tr className="border-b border-line bg-canvas text-[11px] text-muted">
                    <th className="px-3 py-2 font-medium">Platform · type</th>
                    <th className="px-3 py-2 font-medium">Max spend</th>
                    <th className="px-3 py-2 font-medium">Binding</th>
                  </tr>
                </thead>
                <tbody>
                  {pending.slice(0, 5).map((a) => (
                    <tr key={a.id} className="border-b border-line last:border-0 hover:bg-hover-paper">
                      <td className="px-3 py-2">
                        <Link href={`/dashboard/media/approvals/${a.id}`} className="font-medium text-ink hover:underline">
                          {a.binding.platform} · {a.type}
                        </Link>
                      </td>
                      <td className="px-3 py-2 font-semibold text-ink">{money(a.maxSpendCents, a.currency)}</td>
                      <td className="px-3 py-2 font-mono text-[11px] text-muted">binding {a.bindingHash.slice(0, 16)}…</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Kill switches */}
        <section className="rounded-lg border border-line bg-paper p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ink">Kill switches</h2>
            <SeedRulesButton mediaRole={mediaRole} hasRules={rules.length > 0} />
          </div>
          {rules.length === 0 ? (
            <p className="text-sm text-muted">
              No sweeper rules yet. Seed the default v1 pack (stop-loss, test-cap kill, spend-anomaly
              alert, pool-exhausted pause-all, creative-fatigue) — it ships enabled.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {rules.map((r) => (
                <li key={r.id} className="flex items-center justify-between rounded-lg border border-line px-3 py-2 text-sm">
                  <span className="text-ink">{r.name}</span>
                  <span className="flex items-center gap-1.5">
                    <span className={r.enabled ? chipGreen : chipSlate}>{r.enabled ? "armed" : "off"}</span>
                    <span className="text-[11px] text-muted">{r.action}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Active buys */}
        <section className="rounded-lg border border-line bg-paper p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ink">Executed buys</h2>
            <span className="text-xs text-muted">{buys.length} total</span>
          </div>
          {buys.length === 0 ? (
            <p className="text-sm text-muted">No executed buys yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[13px]">
                <thead>
                  <tr className="border-b border-line bg-canvas text-[11px] text-muted">
                    <th className="px-3 py-2 font-medium">Platform</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                    <th className="px-3 py-2 font-medium">Actual spend</th>
                  </tr>
                </thead>
                <tbody>
                  {buys.slice(0, 5).map((b) => (
                    <tr key={b.id} className="border-b border-line last:border-0 hover:bg-hover-paper">
                      <td className="px-3 py-2 font-medium text-ink">{b.platform}</td>
                      <td className="px-3 py-2 text-muted">{b.status}</td>
                      <td className="px-3 py-2 text-muted">
                        {b.actualSpendCents != null ? money(b.actualSpendCents) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
