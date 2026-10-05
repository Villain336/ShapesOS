// ShapesOS — Phase 10 (finance): /dashboard/ops/accounting/reports —
// profit and loss, balance sheet and trial balance for a date range.

import { financePageActor } from "@/lib/ops/finance/page";
import { FinanceHeader } from "@/components/ops-finance/kit";
import { AccountingNav } from "@/components/ops-finance/AccountingNav";
import { ReportsView } from "@/components/ops-finance/AccountingClient";

export const dynamic = "force-dynamic";
export const metadata = { title: "Financial reports — ShapesOS", description: "Profit and loss, balance sheet and trial balance." };

export default async function ReportsPage() {
  await financePageActor();
  return (
    <div className="flex flex-col gap-6">
      <FinanceHeader title="Reports" description="Built from the journal, so they always match the books. Balance sheet and trial balance are as of the end date." />
      <AccountingNav current="reports" />
      <ReportsView />
    </div>
  );
}
