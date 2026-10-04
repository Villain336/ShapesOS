// ShapesOS — Phase 10 (finance): /dashboard/ops/accounting/journal — the
// append-only journal, newest first, with every entry's lines. Manual
// entries and reversals go through an approval.

import { BookOpen } from "lucide-react";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { listAccounts, listJournal } from "@/lib/ops/accounting";
import { financePageActor } from "@/lib/ops/finance/page";
import { Empty, FinanceHeader, Panel, Pill, fmtDay, money } from "@/components/ops-finance/kit";
import { AccountingNav } from "@/components/ops-finance/AccountingNav";
import { ManualEntryButton, ReverseButton } from "@/components/ops-finance/AccountingClient";

export const dynamic = "force-dynamic";
export const metadata = { title: "Journal — ShapesOS", description: "Every journal entry with its lines." };

const SOURCE_LABEL: Record<string, string> = {
  manual: "Manual",
  invoice: "Invoice",
  credit_note: "Credit note",
  payment: "Payment",
  bill: "Vendor bill",
  bill_payment: "Bill payment",
  expense: "Expense claim",
  reversal: "Reversal",
};

export default async function JournalPage() {
  const actor = await financePageActor();
  const { entries, accounts } = await withWorkspaceScope(actor.workspaceId, async (tx) => ({
    accounts: await listAccounts(tx, actor.workspaceId),
    entries: await listJournal(tx, actor.workspaceId, { limit: 100 }),
  }));
  return (
    <div className="flex flex-col gap-6">
      <FinanceHeader
        title="Journal"
        description="Entries are never edited. To correct one, reverse it and post the right entry."
        actions={actor.canEdit ? <ManualEntryButton accounts={accounts} /> : null}
      />
      <AccountingNav current="journal" />
      <Panel>
        {entries.length === 0 ? (
          <Empty icon={<BookOpen size={28} aria-hidden />} title="No entries yet">
            Send an invoice, record a payment or post a vendor bill and its entry appears here.
          </Empty>
        ) : (
          <ul className="divide-y divide-line">
            {entries.map((e) => (
              <li key={e.id} className="px-5 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-muted tabular-nums">{fmtDay(e.entryDate)}</span>
                  <Pill>{SOURCE_LABEL[e.sourceType] ?? e.sourceType}</Pill>
                  {e.reversedById ? <Pill>Reversed</Pill> : null}
                  <span className="min-w-0 flex-1 truncate font-semibold text-ink">{e.memo ?? "Journal entry"}</span>
                  <span className="text-md font-semibold tabular-nums">{money(e.totalCents)}</span>
                  {actor.canEdit && !e.reversedById && !e.reversalOfId ? <ReverseButton entryId={e.id} totalCents={e.totalCents} memo={e.memo} /> : null}
                </div>
                <table className="mt-2 w-full text-sm">
                  <tbody>
                    {e.lines.map((l) => (
                      <tr key={l.id}>
                        <td className={`py-0.5 ${l.creditCents ? "pl-8" : ""}`}>
                          <span className="aos-mono mr-2 text-xs text-muted">{l.accountCode}</span>
                          {l.accountName}
                        </td>
                        <td className="w-32 py-0.5 text-right tabular-nums">{l.debitCents ? money(l.debitCents) : ""}</td>
                        <td className="w-32 py-0.5 text-right tabular-nums">{l.creditCents ? money(l.creditCents) : ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
