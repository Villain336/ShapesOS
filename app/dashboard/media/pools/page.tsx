// Marketr — Budget pools list (Phase 5 S2).
// A pool is a cap with a ledger — Marketr never holds client money.

import { redirect } from "next/navigation";
import Link from "next/link";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { mediaStores, safetyTablesReady } from "@/lib/media/db";
import { mediaRoleForWorkspaceRole } from "@/lib/media/safety";
import { poolUtilization } from "@/lib/media/pools";
import { Badge } from "@/components/vault/shadcn/badge";

export const dynamic = "force-dynamic";
export const metadata = { title: "Budget pools — Media — Marketr" };

function money(cents: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}

export default async function PoolsPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) redirect("/dashboard");
  const mediaRole = mediaRoleForWorkspaceRole(membership.role);

  const ready = await safetyTablesReady().catch(() => false);
  const pools = ready ? await mediaStores().pools.list(workspace.id).catch(() => []) : [];

  return (
    <div className="flex h-full flex-col gap-4 bg-[#FAFAF7] p-4 md:p-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-stone-900">Budget pools</h1>
        <p className="mt-0.5 max-w-2xl text-[13px] text-stone-500">
          Non-custodial caps with encumbrance ledgers. Dual enforcement: software encumbrance +
          a virtual card on the client&apos;s own Brex/Ramp account (limit = pool cap) — the
          money-layer backstop that kills the €7,937/day failure class.
          {mediaRole !== "owner" && " Pool creation requires the owner role."}
        </p>
      </div>
      {pools.length === 0 ? (
        <div className="rounded-xl border border-stone-200 bg-white p-6 text-sm text-stone-500">
          No pools yet. Owners create pools via <code className="font-mono">POST /api/media/pools</code> —
          cap, period, platform allowlist, then attach the client&apos;s virtual card.
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {pools.map((p) => {
            const util = poolUtilization(p) * 100;
            return (
              <Link
                key={p.id}
                href={`/dashboard/media/pools/${p.id}`}
                className="rounded-xl border border-stone-200 bg-white p-4 hover:border-stone-400"
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold text-stone-900">{p.name}</span>
                  <Badge variant={p.status === "active" ? "default" : p.status === "frozen" ? "secondary" : "destructive"}>
                    {p.status}
                  </Badge>
                </div>
                <p className="mt-1 text-xs text-stone-500">{p.period} · {p.platformAllowlist.join(", ")}</p>
                <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-stone-100">
                  <div
                    className={`h-full rounded-full ${util >= 90 ? "bg-red-500" : util >= 75 ? "bg-amber-500" : "bg-emerald-500"}`}
                    style={{ width: `${Math.min(100, util).toFixed(1)}%` }}
                  />
                </div>
                <div className="mt-2 flex justify-between text-xs text-stone-500">
                  <span>{money(p.remainingCents, p.currency)} remaining</span>
                  <span>{money(p.encumberedCents, p.currency)} encumbered</span>
                </div>
                <p className="mt-1 font-mono text-[10px] text-stone-400">
                  card: {p.virtualCardRef ?? "none attached"} ({p.cardProvider})
                </p>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
