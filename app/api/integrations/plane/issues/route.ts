// Marketr — Plane issues endpoint (Phase 12 "Reconsider trio").
// GET /api/integrations/plane/issues?projectId= → { issues, openCount }.
// Reads live from the Plane sidecar; no credentials → honest 400, never fake data.

import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import {
  PlaneApiError,
  PlaneConfigError,
  listPlaneIssues,
  openIssues,
} from "@/lib/integrations/plane";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "viewer"))) return forbidden();
  const projectId = new URL(req.url).searchParams.get("projectId") ?? "";
  try {
    const issues = await listPlaneIssues(projectId);
    return Response.json({ issues, openCount: openIssues(issues).length });
  } catch (e) {
    if (e instanceof PlaneConfigError) {
      const code = /not connected|isn't connected/i.test(e.message) ? "plane_not_configured" : "plane_bad_request";
      return Response.json({ error: e.message, code }, { status: 400 });
    }
    const message = e instanceof PlaneApiError ? e.message : "Plane request failed unexpectedly.";
    return Response.json({ error: message, code: "plane_failed" }, { status: 502 });
  }
}
