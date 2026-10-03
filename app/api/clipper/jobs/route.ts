// Marketr — Phase 13C: job list.
// GET /api/clipper/jobs — recent jobs for the workspace (batch progress UI).

import { guardWorkspace, httpErrorResponse } from "../../integrations/_lib";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const { workspace } = await guardWorkspace();
    const jobs = await withWorkspaceScope(workspace.id, (tx) =>
      tx.clipJob.findMany({
        where: { workspaceId: workspace.id },
        orderBy: { createdAt: "desc" },
        take: 50,
        select: {
          id: true, kind: true, status: true, progress: true,
          error: true, sourceId: true, createdAt: true, updatedAt: true,
        },
      }),
    );
    return Response.json({ jobs });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
