// Marketr — Plane projects endpoint (Phase 12 "Reconsider trio").
// GET /api/integrations/plane/projects → { projects: [{ id, name, identifier }] }.
// Reads live from the Plane sidecar; no credentials → honest 400, never fake data.

import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import {
  PlaneApiError,
  PlaneConfigError,
  listPlaneProjects,
} from "@/lib/integrations/plane";
import { sidecarScoped } from "@/lib/integrations/sidecar-scope";

export const dynamic = "force-dynamic";

async function handleGET() {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "viewer"))) return forbidden();
  try {
    const projects = await listPlaneProjects();
    return Response.json({ projects });
  } catch (e) {
    if (e instanceof PlaneConfigError) {
      return Response.json({ error: e.message, code: "plane_not_configured" }, { status: 400 });
    }
    const message = e instanceof PlaneApiError ? e.message : "Plane request failed unexpectedly.";
    const status = e instanceof PlaneApiError && e.status === 0 ? 502 : 502;
    return Response.json({ error: message, code: "plane_failed" }, { status });
  }
}

// Phase 15.1: run in this workspace's sidecar scope — its own instance;
// a shared one is refused on hosted (lib/integrations/sidecar-tenancy.ts).
export const GET = sidecarScoped(handleGET);
