// ShapesOS — GET /api/agents/activity → { tree, usage }
//
// Read-only feed for the sidebar's "Running now" (lead agent → sub-agents)
// and usage meter, polled while the tab is visible. Any member of the
// current workspace (viewer+); every read runs inside the tenant scope
// (lib/aos/activity.server.ts).

import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { getMembership, forbidden } from "@/lib/authz";
import { errorResponse } from "@/lib/api/errors";
import { loadAgentActivity, safeUsageMeter } from "@/lib/aos/activity.server";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await getMembership(user.id, workspace.id);
  if (!membership) return forbidden();
  try {
    const [activity, usage] = await Promise.all([loadAgentActivity(workspace.id), safeUsageMeter(workspace.id)]);
    return Response.json(
      { tree: activity.tree, usage, generatedAt: activity.generatedAt },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (e) {
    return errorResponse(e, "GET /api/agents/activity");
  }
}
