// Marketr — Phase 14: revoke an action connection.
// DELETE /api/integrations/actions/connections/[id] — soft-revoke (status flip).

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { revokeConnection } from "@/lib/integrations/actions/connections";

export const dynamic = "force-dynamic";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const { id } = await params;
    const result = await revokeConnection(workspace.id, id);
    return Response.json(result);
  } catch (e) {
    return httpErrorResponse(e);
  }
}
