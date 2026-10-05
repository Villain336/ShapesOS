// Marketr — POST /api/media/approvals/:id/submit (draft → pending)

import type { NextRequest } from "next/server";
import { mediaGuard, safetyError } from "../../../_lib";
import { mediaStores, safetyTablesReady } from "@/lib/media/db";
import { submitApproval } from "@/lib/media/approvals";
import { notifyApprovalNeeded } from "@/lib/notifications/producers";

export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await mediaGuard("editor");
  if (gate instanceof Response) return gate;
  if (!(await safetyTablesReady())) {
    return Response.json({ error: "Media safety tables not provisioned yet." }, { status: 503 });
  }
  try {
    const { id } = await params;
    const { approvals } = mediaStores();
    const approval = await submitApproval(approvals, id, gate.workspaceId, gate.userId);
    // Phase 3 (J): only the media owner role (admin+) approves buys.
    await notifyApprovalNeeded({
      workspaceId: gate.workspaceId,
      source: "media",
      sourceId: approval.id,
      title: `${approval.binding.platform} buy up to $${(approval.maxSpendCents / 100).toFixed(2)}`,
      href: `/dashboard/media/approvals/${encodeURIComponent(approval.id)}`,
      requestedBy: gate.userId,
      decideRole: "admin",
    });
    return Response.json({ approval });
  } catch (err) {
    return safetyError(err);
  }
}
