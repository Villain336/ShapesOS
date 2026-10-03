// Marketr — POST /api/media/approvals/:id/approve
//
// Owner-only (buyers propose but never approve — enforced in the service
// layer via assertCanApprove). High-value buys (≥ two-person threshold,
// default $1K) require OTP confirmation producing a cryptographically
// verified approval receipt. Approval encumbers the pool (S2 lifecycle);
// if encumbrance fails (over-encumbrance), the approval rolls back to
// pending — money safety outranks approval state.

import type { NextRequest } from "next/server";
import { mediaGuard, badRequest, safetyError, requireMediaOwner } from "../../../_lib";
import { ApproveSchema } from "../../../_schemas";
import { mediaStores, safetyTablesReady } from "@/lib/media/db";
import { approveApproval } from "@/lib/media/approvals";
import { encumberForApproval } from "@/lib/media/pools";
import { twoPersonThresholdCents } from "@/lib/media/safety";
import { otpChallenges } from "@/lib/media/otp";
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
  const parsed = ApproveSchema.safeParse(raw ?? {});
  if (!parsed.success) return badRequest("Invalid input", parsed.error.issues);

  try {
    const { id } = await params;
    const { approvals, pools } = mediaStores();
    const before = await approvals.get(id, gate.workspaceId);
    const approval = await approveApproval(approvals, {
      id,
      workspaceId: gate.workspaceId,
      approverId: gate.userId,
      approverMediaRole: gate.mediaRole,
      method: parsed.data.method,
      otpChallengeId: parsed.data.otpChallengeId,
      otpCode: parsed.data.otpCode,
      otpStore: otpChallenges,
      twoPersonThresholdCents: twoPersonThresholdCents(),
      onApproved: async (a) => {
        if (!a.poolId) throw new Error("Approval has no pool — every buy must draw from a pool.");
        return encumberForApproval(pools, {
          poolId: a.poolId,
          workspaceId: gate.workspaceId,
          approvalId: a.id,
          amountCents: a.maxSpendCents,
          platform: a.binding.platform,
          actor: gate.userId,
        });
      },
    });
    // Phase 4a: "decided" notification once the buy is actually approved
    // (best-effort, never throws — the decision already landed).
    const decision = mediaDecisionOf(before?.status, approval.status);
    if (decision) await notifyMediaApprovalDecided(approval, decision, gate.userId);
    return Response.json({ approval });
  } catch (err) {
    return safetyError(err);
  }
}
