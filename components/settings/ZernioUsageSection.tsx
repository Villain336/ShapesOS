// ShapesOS — Phase 15.4 (zernio): connected Zernio accounts on Settings → Usage.
// Server component, appended below the usage dashboard (the keys workstream
// owns the rest of the page). Shows the accounts connected now, what the plan
// includes, and the monthly metering snapshots (lib/zernio/metering.ts).

import { prisma } from "@/lib/prisma";
import { ZERNIO_INCLUDED_ACCOUNTS, ZERNIO_POOLED_PLANS } from "@/lib/billing/entitlements";
import { ZERNIO_ACCOUNT_MONTH_CREDITS, ZERNIO_FREE_ACCOUNTS_PER_WORKSPACE, ZERNIO_MANAGED_ADS_MARGIN } from "@/lib/metering/credits";
import { zernioMode } from "@/lib/zernio/config";
import { zernioUsageHistory } from "@/lib/zernio/metering";
import { mirroredAccounts } from "@/lib/zernio/tenancy";

const cardCls = "rounded-xl border border-line bg-paper p-5";
const chipCls =
  "inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-paper px-2 py-0.5 text-xs font-medium text-muted shadow-control";

const STATUS_LABEL: Record<string, string> = {
  charged: "charged",
  included: "included",
  blocked: "blocked by the spend cap",
  error: "could not be read",
};

export default async function ZernioUsageSection({ workspaceId }: { workspaceId: string }) {
  const mode = zernioMode();
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { plan: true } });
  const plan = workspace?.plan ?? "self_hosted";
  const planIncluded = (ZERNIO_INCLUDED_ACCOUNTS as Record<string, number | null>)[plan];
  const pooled = ZERNIO_POOLED_PLANS.has(plan);
  const [accounts, history] = await Promise.all([
    mode === "off" ? Promise.resolve([]) : mirroredAccounts(workspaceId, mode === "live" ? "live" : "mock"),
    zernioUsageHistory(workspaceId),
  ]);
  const connected = accounts.filter((a) => a.status !== "disconnected");
  const included =
    planIncluded === null
      ? "every account (your own Zernio key)"
      : `${Math.max(ZERNIO_FREE_ACCOUNTS_PER_WORKSPACE, planIncluded)}${pooled ? ` pooled across your agency workspaces (${planIncluded} in total)` : ""}`;

  return (
    <section className={cardCls} aria-labelledby="zernio-usage-heading">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id="zernio-usage-heading" className="font-medium text-ink">
            Connected accounts (Zernio)
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Social and ad accounts connected through Zernio. Your plan includes {included}; each account beyond that is{" "}
            {ZERNIO_ACCOUNT_MONTH_CREDITS.toLocaleString("en-US")} credits a month, counted on the 1st. Managed-ad fees Zernio charges for
            this workspace are passed through at cost × {ZERNIO_MANAGED_ADS_MARGIN}.
          </p>
        </div>
        <span className={chipCls}>{mode === "live" ? `${connected.length} connected now` : mode === "mock" ? "Mock Zernio — not billed" : "Zernio is off"}</span>
      </div>

      {connected.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-2">
          {connected.map((a) => (
            <li key={a.accountId} className={chipCls}>
              {a.platform} · {a.username ?? a.displayName ?? a.accountId}
            </li>
          ))}
        </ul>
      )}

      {history.length === 0 ? (
        <p className="mt-3 text-xs text-subtle">No monthly count yet — the first one runs on the 1st of the month.</p>
      ) : (
        <div className="mt-3 overflow-x-auto rounded-lg border border-line">
          <table className="w-full min-w-[560px] text-left text-sm">
            <thead>
              <tr className="border-b border-line bg-canvas">
                <th className="px-3 py-2 text-xs font-semibold text-muted">Month</th>
                <th className="px-3 py-2 text-right text-xs font-semibold text-muted">Connected</th>
                <th className="px-3 py-2 text-right text-xs font-semibold text-muted">Included</th>
                <th className="px-3 py-2 text-right text-xs font-semibold text-muted">Billed accounts</th>
                <th className="px-3 py-2 text-right text-xs font-semibold text-muted">Credits</th>
                <th className="px-3 py-2 text-xs font-semibold text-muted">Status</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.id} className="border-b border-line last:border-0 hover:bg-hover-paper">
                  <td className="px-3 py-2 font-mono text-xs text-ink">{h.month}</td>
                  <td className="px-3 py-2 text-right text-ink">{h.connectedAccounts}</td>
                  <td className="px-3 py-2 text-right text-muted">{h.includedAccounts}</td>
                  <td className="px-3 py-2 text-right text-muted">{h.billableAccounts}</td>
                  <td className="px-3 py-2 text-right text-ink">{(h.accountCredits + h.managedAdsCredits).toLocaleString("en-US")}</td>
                  <td className="px-3 py-2">
                    <span className={chipCls} title={h.detail ?? undefined}>
                      {STATUS_LABEL[h.status] ?? h.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
