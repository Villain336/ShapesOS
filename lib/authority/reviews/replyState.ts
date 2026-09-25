// Marketr — R1 ReviewReplyState polling loop.
//
// SPEC-PHASE6.md §2/R1, §3/F2, §9 invariants 1 & 6.
// Since April 2026 every GBP reply is pre-publication moderated:
// PENDING → APPROVED/REJECTED. A REJECTED reply is silently blocked, so the
// agent polls reply state — never assumes the submit succeeded.
//
// On REJECTED: auto-sanitize (strip likely triggers) + re-draft for human
// re-approval. After 2 rejections: escalate to human-only (status escalated).

import type { GbpClient } from "../fake";
import { sanitizeAndRedraft } from "./drafts";
import type { QueueItem } from "./queue";

export type ReplyState = "PENDING" | "APPROVED" | "REJECTED";

export const MAX_AUTO_REJECTION_RETRIES = 2;

export interface PollOutcome {
  replyState: ReplyState;
  action: "confirmed" | "still_pending" | "sanitized_redrafted" | "escalated";
  queueItem: QueueItem;
}

/** Map the GBP client state to the queue update + next action. */
export function replyStateTransition(args: {
  item: QueueItem;
  polled: ReplyState;
  redraft: () => string; // fresh sanitize+re-draft, called only when needed
}): PollOutcome {
  const { item, polled } = args;

  if (polled === "APPROVED") {
    return {
      replyState: "APPROVED",
      action: "confirmed",
      queueItem: { ...item, replyState: "approved" as const },
    };
  }
  if (polled === "PENDING") {
    return {
      replyState: "PENDING",
      action: "still_pending",
      queueItem: { ...item, replyState: "pending_mod" as const },
    };
  }
  // REJECTED
  const rejectionCount = item.rejectionCount + 1;
  if (rejectionCount >= MAX_AUTO_REJECTION_RETRIES) {
    return {
      replyState: "REJECTED",
      action: "escalated",
      queueItem: {
        ...item,
        replyState: "rejected" as const,
        rejectionCount,
        status: "escalated" as const, // human-only from here
      },
    };
  }
  const redrafted = args.redraft();
  return {
    replyState: "REJECTED",
    action: "sanitized_redrafted",
    queueItem: {
      ...item,
      replyState: "rejected" as const,
      rejectionCount,
      draftReply: redrafted,
      status: "pending" as const, // back to the human for re-approval
      guardrailFlags: Array.from(new Set([...item.guardrailFlags, "auto_sanitized_after_rejection"])),
    },
  };
}

/**
 * Poll the GBP client for a queue item's reply state and compute the
 * transition. Callers persist queueItem back to the store and audit-log.
 */
export async function pollReplyState(args: {
  item: QueueItem;
  gbp: GbpClient;
}): Promise<PollOutcome> {
  const polled = await args.gbp.replyState(args.item.locationRef, args.item.reviewId);
  return replyStateTransition({
    item: args.item,
    polled,
    redraft: () =>
      sanitizeAndRedraft({
        previousDraft: args.item.draftReply ?? "",
        reviewText: args.item.reviewText ?? "",
        rating: args.item.rating,
        sentiment: args.item.sentiment,
        reviewerName: args.item.reviewerName,
      }),
  });
}
