// Marketr — Phase 14: execute an approved action.
// POST /api/integrations/actions/approvals/[id]/execute
// The ONLY route that executes a gated action — requires approved +
// unexpired; always writes a ComposioActionLog.

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { executeApproved } from "@/lib/integrations/actions/gate";

export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { user, workspace } = await guardWorkspace({ editor: true });
    const { id } = await params;
    const result = await executeApproved({
      workspaceId: workspace.id,
      approvalId: id,
      executedBy: user.id,
    });
    return Response.json(result);
  } catch (e) {
    return httpErrorResponse(e);
  }
}
