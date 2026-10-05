// Marketr — Phase 14: decide an approval.
// POST /api/integrations/actions/approvals/[id]/decide
//   { decision: "approved"|"denied", reason?, editedArgs? }

import { z } from "zod";
import { guardWorkspace, httpErrorResponse, readJson } from "@/lib/enrichment/guard";
import { decideApproval, SeparationOfDutiesError } from "@/lib/integrations/actions/gate";

export const dynamic = "force-dynamic";

const DecideSchema = z.object({
  decision: z.enum(["approved", "denied"]),
  reason: z.string().trim().max(2000).optional(),
  editedArgs: z.record(z.string(), z.unknown()).optional(),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    // decidedBy comes from the session, never the body; the gate refuses a
    // requester approving their own action (separation of duties).
    const { user, workspace } = await guardWorkspace({ editor: true });
    const { id } = await params;
    const body = DecideSchema.parse(await readJson(req));
    const approval = await decideApproval({
      workspaceId: workspace.id,
      approvalId: id,
      decision: body.decision,
      decidedBy: user.id,
      reason: body.reason,
      editedArgs: body.editedArgs as Record<string, unknown> | undefined,
    });
    return Response.json({ approval });
  } catch (e) {
    if (e instanceof SeparationOfDutiesError) return Response.json({ error: e.message }, { status: 403 });
    return httpErrorResponse(e);
  }
}
