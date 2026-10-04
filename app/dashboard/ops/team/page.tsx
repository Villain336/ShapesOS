// ShapesOS Phase 10 (ops-core) — /dashboard/ops/team.
import { TeamTab } from "@/components/crm/TeamTab";
import { requireOpsViewer } from "@/lib/ops/page-guard";

export const dynamic = "force-dynamic";

export const metadata = { title: "Team — ShapesOS", description: "Team directory and leave." };

export default async function Page() {
  await requireOpsViewer();
  return <TeamTab />;
}
