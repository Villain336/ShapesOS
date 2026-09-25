// Marketr — R1 review agent: shared types.
//
// SPEC-PHASE6.md §2/R1, §3/F2, §9 invariants 1 & 6.
// Pure type definitions shared by the review pipeline modules and their
// memory-store twins. No imports — safe to load anywhere.

import type {
  ReviewSentiment,
  ReviewQueueStatus,
  ReviewReplyState,
  ReviewSource,
} from "@prisma/client";

export type { ReviewSentiment, ReviewQueueStatus, ReviewReplyState, ReviewSource };

/** Google's four documented review-request channels (2026). Nothing else is allowed. */
export const REVIEW_REQUEST_CHANNELS = [
  "receipt",
  "thank_you_email",
  "end_of_chat",
  "in_store_qr",
] as const;
export type ReviewRequestChannel = (typeof REVIEW_REQUEST_CHANNELS)[number];

export interface ReviewIntakePayload {
  workspaceId: string;
  messageId: string;
  review: {
    reviewId: string;
    locationRef: string;
    source: ReviewSource;
    rating: number; // 1–5
    text: string;
    reviewerName?: string | null;
  };
}

/** Result of the intake pipeline: classification + guardrails + optional draft. */
export interface IntakeResult {
  reviewId: string;
  locationRef: string;
  source: ReviewSource;
  rating: number;
  sentiment: ReviewSentiment;
  urgency: "standard" | "urgent"; // negatives are urgent
  guardrailFlags: string[];
  draftBlocked: boolean;
  draftReply: string | null;
  deduped: boolean;
}

/** The exact payload a review_reply_post approval binds to. */
export interface ReplyPostBinding {
  kind: "review_reply_post";
  reviewQueueId: string;
  reviewId: string;
  locationRef: string;
  source: ReviewSource;
  replyText: string;
  /** "drafts-only" — v1 never auto-posts; v2 opt-in auto-post is NOT built. */
  v1Mode: "approval_queue";
}

/** Review-media object (customer photo) as a brand-intelligence surface. */
export interface ReviewMediaItem {
  reviewId: string;
  mediaId: string;
  mediaUrl: string;
  caption: string | null;
  flaggedAt: Date;
  /** Fixture — GBP customer-photo surfaces feed this in production. */
  fixture: true;
}
