// ShapesOS Phase 10 (ops-core) — /dashboard/ops/projects.
import { ProjectsTab } from "@/components/crm/ProjectsTab";
import { requireOpsViewer } from "@/lib/ops/page-guard";

export const dynamic = "force-dynamic";

export const metadata = { title: "Projects — ShapesOS", description: "Projects, milestones and time." };

export default async function Page() {
  await requireOpsViewer();
  return <ProjectsTab />;
}
