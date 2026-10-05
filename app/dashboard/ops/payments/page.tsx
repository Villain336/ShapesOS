// ShapesOS Phase 10 (ops-core) — /dashboard/ops/payments.
import { PaymentsView } from "@/components/ops/PaymentsView";
import { requireOpsViewer } from "@/lib/ops/page-guard";

export const dynamic = "force-dynamic";

export const metadata = { title: "Payments — ShapesOS", description: "Charge and refund records." };

export default async function Page() {
  await requireOpsViewer();
  return <PaymentsView />;
}
