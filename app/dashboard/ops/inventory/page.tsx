// ShapesOS Phase 10 (ops-core) — /dashboard/ops/inventory.
import { InventoryTab } from "@/components/crm/InventoryTab";
import { requireOpsViewer } from "@/lib/ops/page-guard";

export const dynamic = "force-dynamic";

export const metadata = { title: "Products & inventory — ShapesOS", description: "Products, stock and the inventory ledger." };

export default async function Page() {
  await requireOpsViewer();
  return <InventoryTab />;
}
