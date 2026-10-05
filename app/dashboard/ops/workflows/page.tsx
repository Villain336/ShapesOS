// ShapesOS Phase 10 (ops-core) — /dashboard/ops/workflows.
import { WorkflowsTab } from "@/components/crm/WorkflowsTab";
import { requireOpsViewer } from "@/lib/ops/page-guard";

export const dynamic = "force-dynamic";

export const metadata = { title: "Workflows — ShapesOS", description: "Operations workflows with rollback." };

export default async function Page() {
  await requireOpsViewer();
  return <WorkflowsTab />;
}
