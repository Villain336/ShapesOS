// ShapesOS — Phase 10 (finance): /dashboard/ops/accounting/settings —
// invoice sender details and the workspace's own Stripe connection.

import { headers } from "next/headers";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { getFinanceSettingsView } from "@/lib/ops/finance/stripe";
import { financePageActor } from "@/lib/ops/finance/page";
import { appBaseUrl } from "@/lib/workspace/invite-mail";
import { FinanceHeader, Panel } from "@/components/ops-finance/kit";
import { AccountingNav } from "@/components/ops-finance/AccountingNav";
import { FinanceSettingsForm } from "@/components/ops-finance/AccountingClient";

export const dynamic = "force-dynamic";
export const metadata = { title: "Finance settings — ShapesOS", description: "Invoice sender details and Stripe payments." };

export default async function FinanceSettingsPage() {
  const actor = await financePageActor();
  const settings = await withWorkspaceScope(actor.workspaceId, (tx) => getFinanceSettingsView(tx, actor.workspaceId));
  const h = await headers();
  const origin = h.get("host") ? `${h.get("x-forwarded-proto") ?? "https"}://${h.get("host")}` : null;
  const base = appBaseUrl(process.env, origin) ?? "";
  return (
    <div className="flex flex-col gap-6">
      <FinanceHeader title="Finance settings" description="How invoices and quotes look and how customers can pay them." />
      <AccountingNav current="settings" />
      <Panel title="Invoices and payments">
        <FinanceSettingsForm initial={settings} isAdmin={actor.isAdmin} webhookUrl={`${base}/api/ops/stripe/webhook/${encodeURIComponent(actor.workspaceId)}`} />
      </Panel>
    </div>
  );
}
