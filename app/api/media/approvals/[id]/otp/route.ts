// Marketr — POST /api/media/approvals/:id/otp
// Mint a single-use OTP challenge for a high-value approval.
//
// Phase 1: the challenge is bound to THIS approval and THIS approver, the
// code comes from crypto.randomInt, it is delivered out-of-band (email; dev
// console without SMTP) and NEVER returned in the response. Five wrong
// guesses burn the challenge (lib/media/safety.ts OtpChallengeStore).

import type { NextRequest } from "next/server";
import { mediaGuard, safetyError, requireMediaOwner } from "../../../_lib";
import { mediaStores, safetyTablesReady } from "@/lib/media/db";
import { deliverApprovalOtp, otpChallenges } from "@/lib/media/otp";

export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await mediaGuard("editor");
  if (gate instanceof Response) return gate;
  const ownerCheck = requireMediaOwner(gate.mediaRole);
  if (ownerCheck) return ownerCheck;
  if (!(await safetyTablesReady())) {
    return Response.json({ error: "Media safety tables not provisioned yet." }, { status: 503 });
  }
  try {
    const { id } = await params;
    const approval = await mediaStores().approvals.get(id, gate.workspaceId);
    if (!approval) return Response.json({ error: "Approval not found in workspace." }, { status: 404 });
    if (approval.status !== "pending") {
      return Response.json({ error: "Only pending approvals take an approval code." }, { status: 409 });
    }
    const { challengeId, code, expiresAt } = otpChallenges.mint({ approvalId: id, approverId: gate.userId }, 10);
    const delivered = await deliverApprovalOtp({ to: gate.email, code, approvalId: id, expiresAt });
    if (!delivered.ok) return Response.json({ error: delivered.error }, { status: 503 });
    return Response.json({ challengeId, expiresAt: expiresAt.toISOString(), delivery: delivered.channel });
  } catch (err) {
    return safetyError(err);
  }
}
