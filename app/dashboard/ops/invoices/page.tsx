// ShapesOS Phase 10 (ops-core) — /dashboard/ops/invoices.
import { InvoicesTab } from "@/components/crm/InvoicesTab";
import { requireOpsViewer } from "@/lib/ops/page-guard";

export const dynamic = "force-dynamic";

export const metadata = { title: "Invoices — ShapesOS", description: "Draft, send and collect invoices." };

export default async function Page() {
  await requireOpsViewer();
  return <InvoicesTab />;
}
