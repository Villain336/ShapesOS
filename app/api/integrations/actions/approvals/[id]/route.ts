// Marketr — Phase 14: single approval read.
// GET /api/integrations/actions/approvals/[id] — full detail incl. args.

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { getApproval } from "@/lib/integrations/actions/gate";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { workspace } = await guardWorkspace();
    const { id } = await params;
    const approval = await getApproval(workspace.id, id);
    return Response.json({ approval });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
