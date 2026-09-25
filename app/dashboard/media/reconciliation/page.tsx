// Marketr — /dashboard/media/reconciliation: ledger vs platform actuals.
//
// Variance is surfaced, never silent. Ledger writes require an approvalRef
// (zero-custody invariant) — enforced at the store and the API.

import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { getOrCreateWorkspace } from "@/lib/session";
import { getMediaStore } from "@/lib/media/store";
import { FakePlatformSpendFeed, reconcileBuy } from "@/lib/media/reconciliation";

export const metadata = { title: "Receipt Reconciliation — Marketr" };
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

  const inputCls = "border rounded px-2 py-1 text-sm bg-white dark:bg-neutral-900";
  const thCls = "text-left text-xs uppercase tracking-wide px-3 py-2 text-neutral-500";
  const tdCls = "px-3 py-2 text-sm border-t";
  const money = (c: number) => `$${(c / 100).toFixed(2)}`;

  return (
    <main className="mx-auto max-w-5xl p-6">
      <h1 className="text-2xl font-bold">Receipt reconciliation</h1>
      <p className="mt-1 text-sm text-neutral-500">
        Ledger vs platform actuals/invoices. Variance is surfaced here — never silent.
      </p>

      <form method="GET" className="mt-4 flex items-end gap-2">
        <label className="text-sm">
          Buy ID{" "}
          <input name="buyId" defaultValue={buyId ?? ""} placeholder="buy_…" className={inputCls} />
        </label>
        <button className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white" type="submit">
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
              <div key={label} className="rounded border p-3">
                <div className="text-xs uppercase tracking-wide text-neutral-500">{label}</div>
                <div className="text-lg font-semibold">{value}</div>
              </div>
            ))}
          </div>

          {report.flags.length > 0 && (
            <div className="mt-4 rounded border p-3">
              <h2 className="font-semibold">Flags</h2>
              <ul className="mt-1 list-disc pl-5 text-sm">
                {report.flags.map((f, i) => (
                  <li key={i}>
                    <span className={f.severity === "warn" ? "font-semibold text-amber-700" : "text-neutral-500"}>
                      [{f.code}]
                    </span>{" "}
                    {f.message}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <h2 className="mt-6 font-semibold">Line items</h2>
          <table className="mt-2 w-full">
            <thead>
              <tr>
                <th className={thCls}>Line</th>
                <th className={thCls}>Ledger</th>
                <th className={thCls}>Actual</th>
                <th className={thCls}>Variance</th>
              </tr>
            </thead>
            <tbody>
              {report.lineItems.map((l, i) => (
                <tr key={i}>
                  <td className={tdCls}>{l.label}</td>
                  <td className={tdCls}>{money(l.ledgerCents)}</td>
                  <td className={tdCls}>{money(l.actualCents)}</td>
                  <td className={tdCls}>{money(l.varianceCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <p className="mt-4 text-xs text-neutral-500">
            Ledger entries and receipts are written via <code>POST /api/media/reconciliation</code>
            with a mandatory <code>approvalRef</code> — the safety track&apos;s approval this spend
            traces to. Writes without one are rejected.
          </p>
        </div>
      )}
    </main>
  );
}
