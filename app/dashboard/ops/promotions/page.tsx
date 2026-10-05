// ShapesOS Phase 10 (ops-core) — /dashboard/ops/promotions.
import { PromotionsView } from "@/components/ops/PromotionsView";
import { requireOpsViewer } from "@/lib/ops/page-guard";

export const dynamic = "force-dynamic";

export const metadata = { title: "Promotions — ShapesOS", description: "Discount codes and their rules." };

export default async function Page() {
  await requireOpsViewer();
  return <PromotionsView />;
}
