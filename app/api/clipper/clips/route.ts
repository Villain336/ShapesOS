// Marketr — Phase 13C: clip list.
// GET /api/clipper/clips?sourceId= — clips with scores and statuses for one source.

import { guardWorkspace, httpErrorResponse } from "../../integrations/_lib";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const clipSelect = {
  id: true, sourceId: true, startSec: true, endSec: true,
  viralityScore: true, scoreReasons: true, hookText: true, captionStyle: true,
  captions: true, status: true, renderStatus: true,
  outputRef: true, postizRef: true, createdAt: true,
} as const;

export async function GET(req: Request) {
  try {
    const { workspace } = await guardWorkspace();
    const sourceId = new URL(req.url).searchParams.get("sourceId");
    if (!sourceId) {
      return Response.json({ error: "Query param sourceId is required." }, { status: 400 });
    }
    // Verify the source belongs to this workspace (RLS also enforces it).
    const source = await withWorkspaceScope(workspace.id, (tx) =>
      tx.clipSource.findUnique({ where: { id: sourceId, workspaceId: workspace.id }, select: { id: true } }),
    );
    if (!source) return Response.json({ error: "Source not found." }, { status: 404 });
    const clips = await withWorkspaceScope(workspace.id, (tx) =>
      tx.clip.findMany({
        where: { sourceId, workspaceId: workspace.id },
        orderBy: [{ viralityScore: "desc" }, { createdAt: "asc" }],
        take: 200,
        select: clipSelect,
      }),
    );
    return Response.json({ clips });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
