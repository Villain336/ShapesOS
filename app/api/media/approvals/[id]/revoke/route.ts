// Marketr — POST /api/media/approvals/:id/revoke
// Owner-only. Revocation releases the pool encumbrance (S2 lifecycle).

import type { NextRequest } from "next/server";
import { mediaGuard, badRequest, safetyError, requireMediaOwner } from "../../../_lib";
import { RevokeSchema } from "../../../_schemas";
import { mediaStores, safetyTablesReady } from "@/lib/media/db";
import { revokeApproval } from "@/lib/media/approvals";
import { releaseEncumbrance } from "@/lib/media/pools";
import { mediaDecisionOf, notifyMediaApprovalDecided } from "@/lib/media/decision-notify";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await mediaGuard("editor");
  if (gate instanceof Response) return gate;
  const ownerCheck = requireMediaOwner(gate.mediaRole);
  if (ownerCheck) return ownerCheck;
  if (!(await safetyTablesReady())) {
    return Response.json({ error: "Media safety tables not provisioned yet." }, { status: 503 });
  }
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return badRequest("Invalid JSON");
  }
  const parsed = RevokeSchema.safeParse(raw);
  if (!parsed.success) return badRequest("Invalid input", parsed.error.issues);

  try {
    const { id } = await params;
    const { approvals, pools } = mediaStores();
    const before = await approvals.get(id, gate.workspaceId);
    const approval = await revokeApproval(
      approvals,
      id,
      gate.workspaceId,
      gate.userId,
      gate.mediaRole,
      parsed.data.reason,
      async (a) => {
        if (a.poolId) {
          await releaseEncumbrance(pools, {
            poolId: a.poolId,
            workspaceId: gate.workspaceId,
            approvalId: a.id,
            amountCents: a.maxSpendCents,
            actor: gate.userId,
            reason: `revocation: ${parsed.data.reason}`,
          });
        }
      },
    );
    // Phase 4a: revoking a buy that was still waiting is the "denied"
    // decision (best-effort notification, never throws).
    const decision = mediaDecisionOf(before?.status, approval.status);
    if (decision) await notifyMediaApprovalDecided(approval, decision, gate.userId);
    return Response.json({ approval });
  } catch (err) {
    return safetyError(err);
  }
}
