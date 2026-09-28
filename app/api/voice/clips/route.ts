// Marketr — Phase 13D Worker B: workspace-wide 13C clip picker.
// GET /api/voice/clips → { clips: [{ id, hookText, startSec, endSec,
//   viralityScore, status, renderStatus }] } for the attach-to-clip picker.
// The 13C clips route is source-scoped; this read-only sibling serves the
// voiceover studio without touching clipper files.

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const { workspace } = await guardWorkspace();
    const clips = await withWorkspaceScope(workspace.id, (tx) =>
      tx.clip.findMany({
        where: { workspaceId: workspace.id },
        orderBy: [{ createdAt: "desc" }],
        take: 200,
        select: {
          id: true,
          hookText: true,
          startSec: true,
          endSec: true,
          viralityScore: true,
          status: true,
          renderStatus: true,
        },
      }),
    );
    return Response.json({ clips });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
