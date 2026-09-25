// Marketr — Phase 8 G2: proposal resolution (the human confirmation gate).
// POST /api/substrate/campaigns/link-proposals/:id/resolve
//   { decision: "approved" | "rejected" }
// Approval materializes the link; rejection records the negative signal.

import {
  substrateGuard, badRequest, campaignError, campaignTablesReady, tablesNotReady, readJson,
} from "../../../../_lib";
import { resolveProposal } from "@/lib/substrate/campaigns/store";
import { auditEvent } from "@/lib/auditlog";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await substrateGuard("editor");
  if (gate instanceof Response) return gate;
  if (!(await campaignTablesReady())) return tablesNotReady();
  const { id } = await ctx.params;
  const body = await readJson(req);
  const decision = body.decision as "approved" | "rejected" | undefined;
  if (decision !== "approved" && decision !== "rejected") {
    return badRequest('decision must be "approved" or "rejected"');
  }
  try {
    const result = await resolveProposal(gate.workspaceId, id, decision, gate.userId);
    await auditEvent({
      projectId: null,
      workspaceId: gate.workspaceId,
      action: "link_proposal_resolved",
      summary: `Backfill proposal ${id} ${decision} by ${gate.userId}`,
      actorUserId: gate.userId,
    });
    return Response.json(result);
  } catch (err) {
    return campaignError(err);
  }
}
