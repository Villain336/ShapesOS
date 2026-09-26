// Marketr — POST /api/missions/:id/approvals/:approvalId/decide (editor+)
//
// Contract (M6's approval inbox calls this too — keep it stable):
//   body { decision: "approved" | "denied" }
//   -> validates pending status + expiry, records decidedBy/decidedAt,
//      appends a decision event to the mission timeline.

import type { NextRequest } from "next/server";
import { missionsGuard, badRequest, safetyError, readJson, serializeApproval, missionDeps } from "../../../../_lib";
import { decideApproval, type ApprovalDecision } from "@/lib/missions/engine";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; approvalId: string }> },
) {
  const gate = await missionsGuard("editor");
  if (gate instanceof Response) return gate;
  const { id, approvalId } = await params;
  const body = await readJson(req);
  const decision = body.decision as string;
  if (decision !== "approved" && decision !== "denied") {
    return badRequest('decision must be "approved" or "denied".');
  }
  try {
    const approval = await decideApproval(missionDeps(), {
      missionId: id,
      approvalId,
      workspaceId: gate.workspaceId,
      decision: decision as ApprovalDecision,
      decidedBy: gate.userId,
    });
    return Response.json({ approval: serializeApproval(approval) });
  } catch (err) {
    return safetyError(err);
  }
}
