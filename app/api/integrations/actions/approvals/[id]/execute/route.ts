// Marketr — Phase 14: execute an approved action.
// POST /api/integrations/actions/approvals/[id]/execute
//   { destructiveConfirm?: boolean, confirmedBulkCount?: number }
// The ONLY route that executes a gated action — requires approved +
// unexpired; high tier needs the explicit second confirmation; bulk needs
// the reviewed item count; always writes a ComposioActionLog.

import { z } from "zod";
import { guardWorkspace, httpErrorResponse, readJson } from "@/lib/enrichment/guard";
import { executeApproved } from "@/lib/integrations/actions/gate";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  destructiveConfirm: z.boolean().optional(),
  confirmedBulkCount: z.number().int().min(1).optional(),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { user, workspace } = await guardWorkspace({ editor: true });
    const { id } = await params;
    const body = BodySchema.parse(await readJson(req).catch(() => ({})));
    const result = await executeApproved({
      workspaceId: workspace.id,
      approvalId: id,
      executedBy: user.id,
      destructiveConfirm: body.destructiveConfirm,
      confirmedBulkCount: body.confirmedBulkCount,
    });
    return Response.json(result);
  } catch (e) {
    return httpErrorResponse(e);
  }
}
