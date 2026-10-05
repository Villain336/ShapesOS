// Marketr — R1 approval queue logic (DRAFTS-ONLY v1).
//
// docs/specs/SPEC-PHASE6.md §2/R1, §3/F2, §7, §9 invariants 1 & 6.
// v1 is an approval queue for EVERYTHING: no auto-post code path exists.
// Every post requires an approved review_reply_post approval (two-person)
// whose binding re-verifies before execution (see lib/authority/db.ts).
//
// Pure helpers + a memory queue store (battery twin of prisma ReviewQueue).

import { createId } from "@/lib/media/ids";
import type { ReplyPostBinding, ReviewQueueStatus, ReviewReplyState, ReviewSentiment, ReviewSource } from "./types";

export interface QueueItem {
  id: string;
  workspaceId: string;
  locationRef: string;
  reviewId: string;
  source: ReviewSource;
  rating: number;
  sentiment: ReviewSentiment;
  reviewText: string | null;
  reviewerName: string | null;
  draftReply: string | null;
  guardrailFlags: string[];
  status: ReviewQueueStatus;
  replyState: ReviewReplyState;
  postedAt: Date | null;
  rejectionCount: number;
  createdAt: Date;
}

export interface NewQueueItem {
  workspaceId: string;
  locationRef: string;
  reviewId: string;
  source: ReviewSource;
  rating: number;
  sentiment: ReviewSentiment;
  reviewText?: string | null;
  reviewerName?: string | null;
  draftReply?: string | null;
  guardrailFlags?: string[];
}

/** Build the approval input for posting a reply. Binding is the exact payload. */
export function replyApprovalInput(args: {
  workspaceId: string;
  createdBy: string;
  queueItem: Pick<QueueItem, "id" | "reviewId" | "locationRef" | "source">;
  replyText: string;
}): {
  workspaceId: string;
  type: "review_reply_post";
  bindingJson: Record<string, unknown>;
  createdBy: string;
} {
  const binding: ReplyPostBinding & Record<string, unknown> = {
    kind: "review_reply_post",
    reviewQueueId: args.queueItem.id,
    reviewId: args.queueItem.reviewId,
    locationRef: args.queueItem.locationRef,
    source: args.queueItem.source,
    replyText: args.replyText,
    v1Mode: "approval_queue", // explicit: no auto-post mode exists in v1
  };
  return {
    workspaceId: args.workspaceId,
    type: "review_reply_post",
    bindingJson: binding,
    createdBy: args.createdBy,
  };
}

/** Assert the item is postable: an approved approval must be bound to it. */
export function assertPostable(item: QueueItem, approvalStatus: string): void {
  if (item.status === "posted") {
    throw new Error("Reply already posted — duplicates are blocked.");
  }
  if (approvalStatus !== "approved") {
    throw new Error(
      `Reply is not approved (approval status: ${approvalStatus}). v1 requires an approved review_reply_post approval — posting without approval is blocked.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Memory queue store (battery twin). Mirrors the prisma ReviewQueue shape.
// ---------------------------------------------------------------------------

export function createMemoryReviewQueue() {
  const items = new Map<string, QueueItem>();
  const byReview = new Map<string, string>(); // workspaceId|source|reviewId -> id

  function reviewKey(workspaceId: string, source: string, reviewId: string): string {
    return `${workspaceId}|${source}|${reviewId}`;
  }

  return {
    /** Insert idempotently: duplicate (workspace, source, reviewId) returns existing. */
    upsert(input: NewQueueItem): { item: QueueItem; created: boolean } {
      const key = reviewKey(input.workspaceId, input.source, input.reviewId);
      const existing = byReview.get(key);
      if (existing) return { item: items.get(existing)!, created: false };
      const item: QueueItem = {
        id: createId(),
        workspaceId: input.workspaceId,
        locationRef: input.locationRef,
        reviewId: input.reviewId,
        source: input.source,
        rating: input.rating,
        sentiment: input.sentiment,
        reviewText: input.reviewText ?? null,
        reviewerName: input.reviewerName ?? null,
        draftReply: input.draftReply ?? null,
        guardrailFlags: input.guardrailFlags ?? [],
        status: "pending",
        replyState: "none",
        postedAt: null,
        rejectionCount: 0,
        createdAt: new Date(),
      };
      items.set(item.id, item);
      byReview.set(key, item.id);
      return { item, created: true };
    },
    get(id: string, workspaceId: string): QueueItem | null {
      const item = items.get(id);
      return item && item.workspaceId === workspaceId ? item : null;
    },
    list(workspaceId: string, opts?: { status?: ReviewQueueStatus; sentiment?: ReviewSentiment }): QueueItem[] {
      return [...items.values()]
        .filter(
          (i) =>
            i.workspaceId === workspaceId &&
            (!opts?.status || i.status === opts.status) &&
            (!opts?.sentiment || i.sentiment === opts.sentiment),
        )
        .sort((a, b) => {
          // Urgent first (negatives), then newest.
          if (a.sentiment === "neg" && b.sentiment !== "neg") return -1;
          if (b.sentiment === "neg" && a.sentiment !== "neg") return 1;
          return b.createdAt.getTime() - a.createdAt.getTime();
        });
    },
    patch(id: string, workspaceId: string, patch: Partial<QueueItem>): QueueItem {
      const item = items.get(id);
      if (!item || item.workspaceId !== workspaceId) throw new Error("Queue item not found in workspace.");
      Object.assign(item, patch);
      return item;
    },
  };
}
