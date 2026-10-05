// ShapesOS — Phase 4a: "approval decided" notifications for media buys.
//
// The approve/revoke routes call this after the decision has landed. It goes
// through the Phase 3 producer (lib/notifications/producers.ts), which is
// best-effort and never throws, so a notification failure can never undo or
// fail the decision. Only real decisions notify:
//   - approved: the buy reached "approved" (a first-of-two approval that is
//     still pending is not a decision yet);
//   - denied: a buy that was still waiting (pending) was revoked. Revoking an
//     already-approved buy is a later cancellation, not the approval decision.

import { notifyApprovalDecided, type ProducerDb } from "@/lib/notifications/producers";
import type { MediaApproval } from "./approvals";
import type { ApprovalStatus } from "./safety";

export function mediaDecisionOf(
  before: ApprovalStatus | null | undefined,
  after: ApprovalStatus,
): "approved" | "denied" | null {
  if (after === "approved" && before !== "approved") return "approved";
  if (after === "revoked" && before === "pending") return "denied";
  return null;
}

export async function notifyMediaApprovalDecided(
  approval: Pick<MediaApproval, "id" | "workspaceId" | "createdBy" | "maxSpendCents" | "binding">,
  decision: "approved" | "denied",
  decidedBy: string,
  db?: ProducerDb,
): Promise<number> {
  return notifyApprovalDecided(
    {
      workspaceId: approval.workspaceId,
      source: "media",
      sourceId: approval.id,
      title: `${approval.binding.platform} buy up to $${(approval.maxSpendCents / 100).toFixed(2)}`,
      decision,
      decidedBy,
      requestedBy: approval.createdBy,
      href: `/dashboard/media/approvals/${encodeURIComponent(approval.id)}`,
    },
    db,
  );
}
