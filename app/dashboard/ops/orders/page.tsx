// ShapesOS Phase 10 (ops-core) — /dashboard/ops/orders.
import { OrdersView } from "@/components/ops/OrdersView";
import { requireOpsViewer } from "@/lib/ops/page-guard";

export const dynamic = "force-dynamic";

export const metadata = { title: "Orders — ShapesOS", description: "Sales orders: draft, confirm, fulfil." };

export default async function Page() {
  await requireOpsViewer();
  return <OrdersView />;
}
