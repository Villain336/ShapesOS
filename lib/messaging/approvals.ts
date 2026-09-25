// Marketr — R3 messaging core: approval queue primitives.
//
// Extracted from lib/messaging/dispatcher.ts (the dispatcher re-exports
// these, so the contract is unchanged). Separated so the mail channel
// (lib/messaging/mail-channel.ts) can request approvals without creating
// an import cycle with the dispatcher.

import { prisma } from "@/lib/prisma";
import type { ApprovalItem } from "@prisma/client";

export type MessageKind =
  | "sequence"
  | "speed_to_lead"
  | "missed_call_textback"
  | "review_request"
  | "broadcast"
  | "manual";

/** QueueMessageInput.kind → ApprovalItem.kind for auto-created approvals.
 * ApprovalItem.kind is a free-form string in the schema; requestApproval
 * accepts any non-empty kind so sibling agents (reviews: "review_request",
 * mail: "mail_send") can use their own vocabulary. */
export function approvalKindFor(kind: MessageKind | string): string {
  switch (kind) {
    case "review_request":
      return "review_response";
    case "broadcast":
      return "broadcast";
    default:
      return "sequence_send";
  }
}

export async function requestApproval(input: {
  workspaceId: string;
  kind: string;
  payload: unknown;
  requestedBy?: string;
}): Promise<ApprovalItem> {
  const kind = (input.kind ?? "").trim();
  if (!kind) throw new Error("approval kind is required");
  return prisma.approvalItem.create({
    data: {
      workspaceId: input.workspaceId,
      kind,
      payload: (input.payload ?? {}) as object,
      status: "pending",
      requestedBy: input.requestedBy ?? null,
    },
  });
}

export async function decideApproval(
  id: string,
  workspaceId: string,
  decision: "approve" | "reject",
  decidedBy?: string,
  note?: string,
): Promise<ApprovalItem> {
  const item = await prisma.approvalItem.findFirst({ where: { id, workspaceId } });
  if (!item) throw new Error("Approval item not found");
  if (item.status !== "pending") {
    throw new Error(`Approval item is already ${item.status}`);
  }
  return prisma.approvalItem.update({
    where: { id },
    data: {
      status: decision === "approve" ? "approved" : "rejected",
      decidedBy: decidedBy ?? null,
      decidedAt: new Date(),
      note: note ?? null,
    },
  });
}
