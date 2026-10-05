// Marketr — Plane sidecar status endpoint (Phase 12 "Reconsider trio").
// GET /api/integrations/plane/status → { configured, workspaceSlug }.
// Never exposes key material.

import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import { planeStatus } from "@/lib/integrations/plane";
import { sidecarScoped } from "@/lib/integrations/sidecar-scope";

export const dynamic = "force-dynamic";

async function handleGET() {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "viewer"))) return forbidden();
  const { configured, workspaceSlug } = planeStatus();
  return Response.json({ configured, workspaceSlug });
}

// Phase 15.1: run in this workspace's sidecar scope — its own instance;
// a shared one is refused on hosted (lib/integrations/sidecar-tenancy.ts).
export const GET = sidecarScoped(handleGET);
