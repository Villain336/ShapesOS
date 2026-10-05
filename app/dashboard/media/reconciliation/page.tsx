// Marketr — /dashboard/media/reconciliation: ledger vs platform actuals.
//
// Variance is surfaced, never silent. Ledger writes require an approvalRef
// (zero-custody invariant) — enforced at the store and the API.

import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { getOrCreateWorkspace } from "@/lib/session";
import { getMediaStore } from "@/lib/media/store";
import { FakePlatformSpendFeed, reconcileBuy } from "@/lib/media/reconciliation";

export const metadata = { title: "Receipt Reconciliation — ShapesOS" };
export const dynamic = "force-dynamic";

export default async function MediaReconciliationPage({
  searchParams,
}: {
  searchParams: Promise<{ buyId?: string }>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const sp = await searchParams;
  const workspace = await getOrCreateWorkspace(session.user.id, session.user.email);
  const ws = workspace.id;
  const buyId = (sp.buyId ?? "").trim() || null;

  const report = buyId
    ? await reconcileBuy(getMediaStore(), new FakePlatformSpendFeed(), ws, buyId)
    : null;

  const inputCls = "rounded-md border border-line bg-paper px-2.5 py-1.5 text-[13px] text-ink placeholder:text-subtle focus:border-focus focus:ring-[3px] focus:ring-[var(--aos-focus-halo)] focus:outline-none";
  const thCls = "px-3 py-2 font-medium";
  const tdCls = "px-3 py-2";
  const money = (c: number) => `$${(c / 100).toFixed(2)}`;

  return (
    <div className="flex h-full flex-col gap-4 bg-canvas p-4 md:p-6">
      <h1 className="aos-heading text-ink">Receipt reconciliation</h1>
      <p className="mt-0.5 max-w-2xl text-[13px] text-muted">
        Ledger vs platform actuals/invoices. Variance is surfaced here — never silent.
      </p>

      <form method="GET" className="mt-4 flex items-end gap-2">
        <label className="text-[13px] text-muted">
          Buy ID{" "}
          <input name="buyId" defaultValue={buyId ?? ""} placeholder="buy_…" className={inputCls} />
        </label>
        <button className="flex items-center gap-1.5 rounded-full bg-ink px-3 py-1.5 text-[13px] font-semibold text-white aos-press disabled:opacity-40" type="submit">
          Reconcile
        </button>
      </form>

      {report && (
        <div className="mt-6">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {(
              [
                ["Ledger spend", money(report.ledger.spendCents)],
                ["Platform actuals", money(report.actual.totalCents)],
                ["Variance", money(report.varianceCents)],
                ["Receipts", `${report.receipts.reconciled}/${report.receipts.count} reconciled`],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="rounded-lg border border-line bg-paper p-3">
                <div className="text-[11px] font-semibold text-muted">{label}</div>
                <div className="text-lg font-semibold text-ink">{value}</div>
              </div>
            ))}
          </div>

          {report.flags.length > 0 && (
            <div className="mt-4 rounded-lg border border-line bg-paper p-4">
              <h2 className="text-sm font-semibold text-ink">Flags</h2>
              <ul className="mt-1 list-disc pl-5 text-sm">
                {report.flags.map((f, i) => (
                  <li key={i}>
                    <span className={f.severity === "warn" ? "font-semibold text-needs" : "text-muted"}>
                      [{f.code}]
                    </span>{" "}
                    {f.message}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <h2 className="mt-6 text-sm font-semibold text-ink">Line items</h2>
          <div className="mt-2 overflow-x-auto rounded-lg border border-line bg-paper"><table className="w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-line bg-canvas text-[11px] font-semibold text-muted">
                <th className={thCls}>Line</th>
                <th className={thCls}>Ledger</th>
                <th className={thCls}>Actual</th>
                <th className={thCls}>Variance</th>
              </tr>
            </thead>
            <tbody>
              {report.lineItems.map((l, i) => (
                <tr key={i} className="border-b border-line last:border-0 hover:bg-hover-paper">
                  <td className={tdCls}>{l.label}</td>
                  <td className={tdCls}>{money(l.ledgerCents)}</td>
                  <td className={tdCls}>{money(l.actualCents)}</td>
                  <td className={tdCls}>{money(l.varianceCents)}</td>
                </tr>
              ))}
            </tbody>
          </table></div>

          <p className="mt-4 text-xs text-muted">
            Ledger entries and receipts are written via <code>POST /api/media/reconciliation</code>
            with a mandatory <code>approvalRef</code> — the safety track&apos;s approval this spend
            traces to. Writes without one are rejected.
          </p>
        </div>
      )}
    </div>
  );
}
