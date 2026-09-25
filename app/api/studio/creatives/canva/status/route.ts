// Marketr — studio creative Canva connection status (Phase 4, T2).
// GET /api/studio/creatives/canva/status
// Workspace-level (guardWorkspace): the Canva account is per-workspace.

import { prisma } from "@/lib/prisma";
import { getCanvaStatus } from "@/lib/studio/service";
import { creativeErrorResponse, guardWorkspace } from "../../_lib";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { workspace } = await guardWorkspace();
    const status = await getCanvaStatus(prisma, workspace.id);
    return Response.json({ status, workspaceId: workspace.id });
  } catch (e) {
    return creativeErrorResponse(e);
  }
}
