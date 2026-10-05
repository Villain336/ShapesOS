// ShapesOS Phase 10 (ops-core) — /dashboard/ops/team.
import { TeamWorkspace } from "@/components/ops/TeamViews";
import { requireOpsViewer } from "@/lib/ops/page-guard";

export const dynamic = "force-dynamic";

export const metadata = { title: "Team — ShapesOS", description: "People, departments, leave balances and recruiting." };

export default async function Page() {
  await requireOpsViewer();
  return <TeamWorkspace />;
}
