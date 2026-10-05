// Marketr — Budget pools list (Phase 5 S2).
// A pool is a cap with a ledger — Marketr never holds client money.

import { redirect } from "next/navigation";
import Link from "next/link";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { mediaStores, safetyTablesReady } from "@/lib/media/db";
import { mediaRoleForWorkspaceRole } from "@/lib/media/safety";
import { poolUtilization } from "@/lib/media/pools";

// Pool status is not an agent state: neutral chips, told apart by label.
const chip =
  "inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-canvas px-2 py-0.5 text-[12px] font-semibold leading-tight";
const chipSlate = `${chip} text-muted`;
const chipGreen = `${chip} text-ink`;
const chipRed = `${chip} text-ink`;

function poolStatusTone(status: string): string {
  return status === "active" ? chipGreen : status === "frozen" ? chipRed : chipSlate;
}

export const dynamic = "force-dynamic";
export const metadata = { title: "Budget pools — Media — ShapesOS" };

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
    <div className="flex h-full flex-col gap-4 bg-canvas p-4 md:p-6">
      <div>
        <h1 className="aos-heading text-ink">Budget pools</h1>
        <p className="mt-0.5 max-w-2xl text-[13px] text-muted">
          Non-custodial caps with encumbrance ledgers. Dual enforcement: software encumbrance +
          a virtual card on the client&apos;s own Brex/Ramp account (limit = pool cap) — the
          money-layer backstop that kills the €7,937/day failure class.
          {mediaRole !== "owner" && " Pool creation requires the owner role."}
        </p>
      </div>
      {pools.length === 0 ? (
        <div className="rounded-lg bg-paper p-6 text-sm text-muted shadow-hairline">
          No pools yet. Owners create pools via <code className="font-mono">POST /api/media/pools</code> —
          cap, period, platform allowlist, then attach the client&apos;s virtual card.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg bg-paper shadow-hairline">
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-line bg-canvas text-xs text-muted">
                <th className="px-3 py-2 font-semibold">Pool</th>
                <th className="px-3 py-2 font-semibold">Status</th>
                <th className="px-3 py-2 font-semibold">Period</th>
                <th className="px-3 py-2 font-semibold">Platforms</th>
                <th className="px-3 py-2 font-semibold">Remaining</th>
                <th className="px-3 py-2 font-semibold">Encumbered</th>
                <th className="px-3 py-2 font-semibold">Utilization</th>
                <th className="px-3 py-2 font-semibold">Card</th>
              </tr>
            </thead>
            <tbody>
              {pools.map((p) => {
                const util = poolUtilization(p) * 100;
                return (
                  <tr key={p.id} className="border-b border-line last:border-0 hover:bg-hover-paper">
                    <td className="px-3 py-2">
                      <Link href={`/dashboard/media/pools/${p.id}`} className="font-medium text-ink hover:underline">
                        {p.name}
                      </Link>
                    </td>
                    <td className="px-3 py-2"><span className={poolStatusTone(p.status)}>{p.status}</span></td>
                    <td className="px-3 py-2 text-muted">{p.period}</td>
                    <td className="px-3 py-2 text-[12px] text-muted">{p.platformAllowlist.join(", ")}</td>
                    <td className="px-3 py-2 font-medium text-ink">{money(p.remainingCents, p.currency)}</td>
                    <td className="px-3 py-2 text-muted">{money(p.encumberedCents, p.currency)}</td>
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
                    <td className="px-3 py-2 font-mono text-[11px] text-muted">
                      {p.virtualCardRef ?? "none"} ({p.cardProvider})
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
