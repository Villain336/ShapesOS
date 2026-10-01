// Marketr — Wave 2 Insurance slice 3a: pending governed approvals API.
// GET /api/insurance/governance/pending[?action=bind_policy] — list pending
// insurance governed approvals for the workspace (editor role). Optional
// action filter.

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { InsuranceError } from "@/lib/insurance/types";
import { getPendingApprovals } from "@/lib/insurance/governance";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const { searchParams } = new URL(req.url);
    const action = searchParams.get("action") ?? undefined;

    const approvals = await getPendingApprovals(workspace.id, action);

    return Response.json({
      approvals: approvals.map((a) => ({
        id: a.id,
        kind: a.kind,
        payload: a.payload,
        status: a.status,
        requestedBy: a.requestedBy,
      })),
    });
  } catch (e) {
    if (e instanceof InsuranceError) {
      return Response.json({ error: e.message, code: e.code }, { status: 400 });
    }
    return httpErrorResponse(e);
  }
}
