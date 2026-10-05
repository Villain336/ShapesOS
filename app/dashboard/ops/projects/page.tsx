// ShapesOS Phase 10 (ops-core) — /dashboard/ops/projects.
import { ProjectsWorkspace } from "@/components/ops/ProjectsViews";
import { requireOpsViewer } from "@/lib/ops/page-guard";

export const dynamic = "force-dynamic";

export const metadata = { title: "Projects — ShapesOS", description: "Projects, tasks, timesheets and billing time." };

export default async function Page() {
  await requireOpsViewer();
  return <ProjectsWorkspace />;
}
