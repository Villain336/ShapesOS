// Marketr — replay events by share id (Phase 12 "embeds", rrweb).
// GET /api/studio/designs/[id]/shares/[shareId]/replay/[sessionId]
//   → { events }
// Workspace-authenticated companion to /api/s/[token]/replay/[sessionId]:
// lets workspace members open a session recording from the share-management
// UI without ever handling the raw (shown-once) token.

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { readReplaySession } from "@/lib/integrations/replay";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string; shareId: string; sessionId: string }> },
) {
  try {
    const { workspace } = await guardWorkspace();
    const { id: designId, shareId, sessionId } = await ctx.params;

    const share = await prisma.designShare.findFirst({
      where: {
        id: shareId,
        designId,
        workspaceId: workspace.id,
        replayOptIn: true,
        revokedAt: null,
      },
      select: { id: true },
    });
    if (!share) return Response.json({ error: "Not found" }, { status: 404 });

    const events = await readReplaySession(share.id, sessionId);
    if (!events) return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json({ events });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
