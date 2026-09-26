// Marketr — POST /api/automation/decide (Phase 9 M6).
//
// Contract (identical semantics to M4's
// POST /api/missions/:id/approvals/:approvalId/decide): body
// { approvalId, missionId?, decision } with decision ∈ {approved, denied}
// (approve/deny accepted as aliases). Approvals without a missionId are
// decided here; approvals WITH a missionId may be decided here too
// (missionId is cross-checked) or via M4's route once it lands.
//
// Semantics: pending-only; expired approvals flip to expired (410);
// every decide appends a hash-chained row to mission_approval_events.

import { decideApproval } from "@/lib/automation/decide";
import { normalizeDecision } from "@/lib/automation/decide";
import { automationGuard, badRequest, decideError, readJson } from "../_lib";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const access = await automationGuard("editor");
  if (access instanceof Response) return access;

  const body = await readJson(req);
  const decision = normalizeDecision(body.decision);
  if (!decision) {
    return badRequest("decision must be one of: approved, denied (approve/deny accepted).");
  }
  const approvalId = typeof body.approvalId === "string" ? body.approvalId : "";
  if (!approvalId) return badRequest("approvalId is required.");
  const missionId =
    typeof body.missionId === "string" && body.missionId ? body.missionId : null;

  try {
    const outcome = await decideApproval(access.workspaceId, {
      approvalId,
      missionId,
      decision,
      actor: access.userId,
    });
    return Response.json({ ok: true, ...outcome });
  } catch (err) {
    return decideError(err);
  }
}
