// Marketr — POST /api/mail/campaigns/[id]/request-approval
//
// Open a C3 approval binding creativeHash + sendable pieceCount +
// maxSpendCents (from the estimate incl. margin preview). The campaign
// moves to pending_approval.

import type { NextRequest } from "next/server";
import { mailGuard, badRequest } from "../../../_lib";
import { requestApproval } from "@/lib/mail/service";

export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await mailGuard("editor");
  if (gate instanceof Response) return gate;
  const { id } = await params;

  try {
    const { approval, estimate } = await requestApproval(gate.workspaceId, id, {
      requestedBy: gate.userId,
    });
    return Response.json({ approval, estimate }, { status: 201 });
  } catch (e) {
    return badRequest(e instanceof Error ? e.message : "Approval request failed");
  }
}
