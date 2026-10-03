// Marketr — Phase 13C: job detail.
// GET /api/clipper/jobs/[id] — job record + progress.

import { guardWorkspace, httpErrorResponse } from "../../../integrations/_lib";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { workspace } = await guardWorkspace();
    const { id } = await ctx.params;
    const job = await withWorkspaceScope(workspace.id, (tx) =>
      tx.clipJob.findUnique({ where: { id, workspaceId: workspace.id } }),
    );
    if (!job) return Response.json({ error: "Job not found." }, { status: 404 });
    return Response.json({ job });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
