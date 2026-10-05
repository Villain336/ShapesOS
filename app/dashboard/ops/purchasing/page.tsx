// ShapesOS Phase 10 (ops-core) — /dashboard/ops/purchasing.
import { PurchasingWorkspace } from "@/components/ops/InventoryViews";
import { requireOpsViewer } from "@/lib/ops/page-guard";

export const dynamic = "force-dynamic";

export const metadata = { title: "Purchasing — ShapesOS", description: "Purchase orders and reorder rules." };

export default async function Page() {
  await requireOpsViewer();
  return <PurchasingWorkspace />;
}
