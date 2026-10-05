// ShapesOS Phase 10 (ops-core) — /dashboard/ops/helpdesk.
import { HelpdeskWorkspace } from "@/components/ops/HelpdeskViews";
import { requireOpsViewer } from "@/lib/ops/page-guard";

export const dynamic = "force-dynamic";

export const metadata = { title: "Helpdesk — ShapesOS", description: "Support tickets, SLA policies and the support inbox." };

export default async function Page() {
  await requireOpsViewer();
  return <HelpdeskWorkspace />;
}
