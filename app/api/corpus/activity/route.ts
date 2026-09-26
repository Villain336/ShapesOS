// Marketr — Knowledge Brain: corpus activity feed API.
// GET /api/corpus/activity → { events: ActivityEvent[] } (viewer+).
//
// Real events only: source proposals, removal flags, rebuild job history,
// and manifest version bumps. Assembled by buildActivityEvents() in
// lib/intelligence/corpus/activity.ts.

import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import { loadManifest } from "@/lib/intelligence/corpus/store";
import { buildActivityEvents } from "@/lib/intelligence/corpus/activity";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "viewer"))) return forbidden();

  const events = buildActivityEvents(loadManifest());
  return Response.json({ events });
}
