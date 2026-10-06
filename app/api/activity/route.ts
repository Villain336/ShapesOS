// ShapesOS — Phase 18.2 (WS=content): the Activity Monitor, one snapshot.
// GET /api/activity → { processes, health } (lib/aos/activity.server.ts
// loadProcessSnapshot). Any member: the workspace's runs, jobs, batches,
// sandboxes and terminal sessions (the Runs page shows the same runs); the
// system-wide rows of the health panel (cron jobs, database connections) are
// admin+ only. Live updates: GET /api/activity/stream (SSE).

import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { forbidden, requireWorkspaceRole, roleAtLeast } from "@/lib/authz";
import { errorResponse } from "@/lib/api/errors";
import { loadProcessSnapshot } from "@/lib/aos/activity.server";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const user = await requireUser();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const workspace = await getOrCreateWorkspace(user.id, user.email);
    const m = await requireWorkspaceRole(user.id, workspace.id, "viewer");
    if (!m) return forbidden();
    const snapshot = await loadProcessSnapshot(workspace.id, { userId: user.id, isAdmin: roleAtLeast(m.role, "admin") });
    return Response.json(snapshot, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err, "GET /api/activity");
  }
}
