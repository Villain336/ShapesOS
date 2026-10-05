// ShapesOS Phase 10 (ops-core) — /dashboard/ops/inventory.
import { InventoryWorkspace } from "@/components/ops/InventoryViews";
import { requireOpsViewer } from "@/lib/ops/page-guard";

export const dynamic = "force-dynamic";

export const metadata = { title: "Products & inventory — ShapesOS", description: "Products, variants, warehouses, stock by location and transfers." };

export default async function Page() {
  await requireOpsViewer();
  return <InventoryWorkspace />;
}
