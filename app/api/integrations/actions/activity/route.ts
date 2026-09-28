// Marketr — Phase 14: action audit log API.
// GET /api/integrations/actions/activity — every execution, newest first.

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { listActionLogs } from "@/lib/integrations/actions/gate";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { workspace } = await guardWorkspace();
    const logs = await listActionLogs(workspace.id);
    return Response.json({ logs });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
