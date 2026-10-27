// ShapesOS Phase 24 - GET /api/store/bundles: the curated bundles with, for
// this person, what each member would do (install, already installed,
// connect separately, blocked by role, unavailable). Any member (viewer).

import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { forbidden, requireWorkspaceRole } from "@/lib/authz";
import { errorResponse } from "@/lib/api/errors";
import { listBundlePlans } from "@/lib/store/bundles-service";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const user = await requireUser();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const workspace = await getOrCreateWorkspace(user.id, user.email);
    const m = await requireWorkspaceRole(user.id, workspace.id, "viewer");
    if (!m) return forbidden();
    const bundles = await listBundlePlans({ workspaceId: workspace.id, userId: user.id, role: m.role });
    return Response.json({ bundles }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err, "GET /api/store/bundles");
  }
}
