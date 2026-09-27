// Marketr — replay session events (Phase 12 "embeds", rrweb).
// GET /api/s/[token]/replay/[sessionId] — the event payload for the
// viewer. Workspace-authenticated and tenant-scoped to the share.

import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { readReplaySession, resolveActiveShare } from "@/lib/integrations/replay";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ token: string; sessionId: string }> },
) {
  const { token, sessionId } = await ctx.params;
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const share = await resolveActiveShare(token);
  if (!share || share.workspaceId !== workspace.id) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  const events = await readReplaySession(share.id, sessionId);
  if (!events) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ events });
}
