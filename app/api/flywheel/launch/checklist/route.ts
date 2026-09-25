// Marketr — GET /api/flywheel/launch/checklist (viewer)
// The F6 launch-readiness checklist: every item grouped by category with
// progress. Seeds the catalog rows idempotently on first read so a fresh
// workspace always sees the full checklist.

import { launchGuard } from "@/app/api/flywheel/launch/_lib";
import {
  launchTablesReady,
  seedLaunchChecklist,
  listLaunchChecklist,
  progressOf,
} from "@/lib/flywheel/launch/store";
import { LAUNCH_CATEGORIES, LAUNCH_CHECKLIST_CATALOG } from "@/lib/flywheel/launch/catalog";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await launchGuard("viewer");
  if (gate instanceof Response) return gate;
  if (!(await launchTablesReady())) {
    return Response.json({ error: "Launch tables not provisioned yet." }, { status: 503 });
  }
  await seedLaunchChecklist(gate.workspaceId);
  const rows = await listLaunchChecklist(gate.workspaceId);
  // Catalog order (not DB insertion order) so the UI is stable.
  const order = new Map(LAUNCH_CHECKLIST_CATALOG.map((c, i) => [c.key, i]));
  rows.sort((a, b) => (order.get(a.key) ?? 99) - (order.get(b.key) ?? 99));
  const catalog = new Map(LAUNCH_CHECKLIST_CATALOG.map((c) => [c.key, c]));
  return Response.json({
    categories: LAUNCH_CATEGORIES,
    progress: progressOf(rows),
    items: rows.map((r) => ({
      ...r,
      catalog: catalog.get(r.key) ?? null,
    })),
    openCoreSplitDecided: false,
  });
}
