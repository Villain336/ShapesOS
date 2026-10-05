// ShapesOS — Phase 10 (finance): /dashboard/ops/accounting — the chart of
// accounts (seeded with a standard small-business chart on first visit) with
// each account's balance to date, and the workspace's tax rates.

import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { listAccounts, loadAccountSums, isDebitNormal } from "@/lib/ops/accounting";
import { financePageActor } from "@/lib/ops/finance/page";
import { DataTable, FinanceHeader, Panel, Pill, cellCls, money, numCls, rowCls } from "@/components/ops-finance/kit";
import { AccountingNav } from "@/components/ops-finance/AccountingNav";
import { ActiveToggle, NewAccountButton, NewTaxRateButton } from "@/components/ops-finance/AccountingClient";

export const dynamic = "force-dynamic";
export const metadata = { title: "Accounting — ShapesOS", description: "Chart of accounts, journal and reports." };

const TYPE_LABEL: Record<string, string> = { asset: "Asset", liability: "Liability", equity: "Equity", income: "Income", expense: "Expense" };

export default async function AccountingPage() {
  const actor = await financePageActor();
  const { accounts, sums, rates } = await withWorkspaceScope(actor.workspaceId, async (tx) => ({
    accounts: await listAccounts(tx, actor.workspaceId),
    sums: await loadAccountSums(tx, actor.workspaceId, {}),
    rates: await tx.opsTaxRate.findMany({ where: { workspaceId: actor.workspaceId }, orderBy: { name: "asc" } }),
  }));
  const byId = new Map(accounts.map((a) => [a.id, a]));
  return (
    <div className="flex flex-col gap-6">
      <FinanceHeader
        title="Accounting"
        description={`Double-entry books for ${actor.workspaceName}. Invoices, payments, bills and expense claims post here automatically; manual entries need an approval.`}
        actions={actor.canEdit ? <NewAccountButton accounts={accounts} /> : null}
      />
      <AccountingNav current="accounts" />
      <Panel title="Chart of accounts">
        <DataTable head={[{ label: "Code" }, { label: "Account" }, { label: "Type" }, { label: "Balance", align: "right" }, { label: "" }]}>
          {accounts.map((a) => {
            const s = sums.get(a.id);
            const bal = s ? (isDebitNormal(a.type) ? s.debitCents - s.creditCents : s.creditCents - s.debitCents) : 0;
            return (
              <tr key={a.id} className={rowCls}>
                <td className={`${cellCls} aos-mono text-sm`}>{a.code}</td>
                <td className={cellCls}>
                  <span className={a.active ? "font-semibold" : "font-semibold text-subtle"}>{a.name}</span>
                  {a.parentId && byId.get(a.parentId) ? <span className="ml-2 text-sm text-muted">under {byId.get(a.parentId)!.name}</span> : null}
                </td>
                <td className={cellCls}>
                  <span className="flex flex-wrap gap-1.5">
                    <Pill>{TYPE_LABEL[a.type]}</Pill>
                    {a.systemKey ? <Pill>Automatic posting</Pill> : null}
                    {!a.active ? <Pill>Inactive</Pill> : null}
                  </span>
                </td>
                <td className={numCls}>{money(bal)}</td>
                <td className={`${cellCls} text-right`}>{actor.canEdit && !a.systemKey ? <ActiveToggle entity="accounts" id={a.id} active={a.active} label={a.name} /> : null}</td>
              </tr>
            );
          })}
        </DataTable>
      </Panel>
      <Panel title="Tax rates" actions={actor.canEdit ? <NewTaxRateButton /> : null}>
        {rates.length === 0 ? (
          <p className="px-5 py-5 text-md text-muted">No tax rates yet. Add one and pick it on invoice, quote and bill lines; the tax is worked out per line.</p>
        ) : (
          <DataTable head={[{ label: "Name" }, { label: "Rate", align: "right" }, { label: "State" }, { label: "" }]} minWidth={520}>
            {rates.map((r) => (
              <tr key={r.id} className={rowCls}>
                <td className={`${cellCls} font-semibold`}>{r.name}</td>
                <td className={numCls}>{(r.rateBps / 100).toFixed(2)}%</td>
                <td className={cellCls}>
                  <Pill>{r.active ? "Active" : "Inactive"}</Pill>
                </td>
                <td className={`${cellCls} text-right`}>{actor.canEdit ? <ActiveToggle entity="tax-rates" id={r.id} active={r.active} label={r.name} /> : null}</td>
              </tr>
            ))}
          </DataTable>
        )}
      </Panel>
    </div>
  );
}
