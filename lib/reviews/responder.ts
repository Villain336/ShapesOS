// Marketr — R4 review responder: AI draft replies for monitored reviews.
//
// The Review model (M16) is read-only monitoring intel. This module generates
// a draft reply with the "copy" workload LLM and puts it in the human
// approval queue (ApprovalItem kind "review_response"). NOTHING is posted
// automatically.
//
// Honest limitation: actually publishing a reply to Google requires GBP API
// approval, which is still pending (Phase 2 research). recordManualPost()
// marks the review responded and records "manual post required until GBP
// approval" — it never fakes a Google API call.

import { prisma } from "@/lib/prisma";
import { getLlmProviderFor, WORKLOAD_MAX_TOKENS } from "@/lib/llm";
import { requestApproval } from "@/lib/messaging/dispatcher";
import { brandToneFor } from "./engine";
import type { ApprovalItem, Review } from "@prisma/client";

export class ResponderError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ResponderError";
    this.code = code;
  }
}

export interface IncomingReview extends Review {
  approvalStatus: string | null;
  approvalId: string | null;
}

/** Monitored reviews (M16) in this workspace that still need a response. */
export async function listIncomingReviews(
  workspaceId: string,
  opts?: { limit?: number },
): Promise<IncomingReview[]> {
  const reviews = await prisma.review.findMany({
    where: { project: { workspaceId }, responded: false },
    orderBy: [{ publishedAt: "desc" }, { createdAt: "desc" }],
    take: Math.min(opts?.limit ?? 50, 200),
  });
  // Latest approval state per review (payload.reviewId match).
  const approvals = await prisma.approvalItem.findMany({
    where: { workspaceId, kind: "review_response" },
    orderBy: { createdAt: "desc" },
    take: 200,
    select: { id: true, status: true, payload: true, createdAt: true },
  });
  const byReview = new Map<string, { id: string; status: string }>();
  for (const a of approvals) {
    const p = a.payload as { reviewId?: string } | null;
    if (p?.reviewId && !byReview.has(p.reviewId)) {
      byReview.set(p.reviewId, { id: a.id, status: a.status });
    }
  }
  return reviews.map((r) => ({
    ...r,
    approvalStatus: byReview.get(r.id)?.status ?? null,
    approvalId: byReview.get(r.id)?.id ?? null,
  }));
}

function buildResponsePrompt(args: {
  businessName: string;
  author: string | null;
  rating: number | null;
  text: string | null;
  sentiment: string;
  tone: string | null;
}): string {
  const { businessName, author, rating, text, sentiment, tone } = args;
  return [
    `You are writing a public reply to a Google review for the business "${businessName}".`,
    tone ? `Brand voice to match: ${tone}` : "Brand voice: warm, professional, concise.",
    "",
    `Reviewer: ${author ?? "Anonymous"}`,
    `Rating: ${rating ?? "unknown"} / 5`,
    `Sentiment: ${sentiment}`,
    `Review text: ${text?.trim() ? JSON.stringify(text.trim().slice(0, 2000)) : "(no text, star rating only)"}`,
    "",
    "Write the reply the business should post publicly. Rules:",
    "- 2-4 sentences. Address the reviewer by first name when known.",
    "- Thank positive reviewers specifically (mention what they praised).",
    "- For negative reviews: acknowledge, apologize once without admitting legal fault, invite them to contact the business directly. Never argue, never offer compensation publicly.",
    "- Sign as the business team (e.g. 'The Acme team').",
    "- Plain text only, no placeholders, no hashtags.",
    "Reply with ONLY the reply text.",
  ].join("\n");
}

export async function draftReviewResponse(
  workspaceId: string,
  reviewId: string,
  opts?: { requestedBy?: string },
): Promise<{ review: Review; draftBody: string; approval: ApprovalItem; mock: boolean }> {
  const review = await prisma.review.findFirst({
    where: { id: reviewId, project: { workspaceId } },
  });
  if (!review) throw new ResponderError("not_found", "Review not found in this workspace");
  if (review.responded) {
    throw new ResponderError("already_responded", "This review is already marked responded");
  }

  const tone = await brandToneFor(workspaceId);
  const llm = getLlmProviderFor("copy");
  const raw = await llm.generate(
    buildResponsePrompt({
      businessName: review.businessName,
      author: review.author,
      rating: review.rating,
      text: review.text,
      sentiment: review.sentiment,
      tone,
    }),
    { maxTokens: Math.min(512, WORKLOAD_MAX_TOKENS.copy) },
  );
  const draftBody = raw.trim();
  if (!draftBody) throw new ResponderError("empty_draft", "LLM returned an empty draft");

  const approval = await requestApproval({
    workspaceId,
    kind: "review_response",
    payload: {
      reviewId: review.id,
      businessName: review.businessName,
      author: review.author,
      rating: review.rating,
      reviewText: review.text,
      draftBody,
      channel: "google",
      note: "manual post required until GBP approval",
    },
    requestedBy: opts?.requestedBy,
  });

  return { review, draftBody, approval, mock: !llm.isLive };
}

/**
 * Record that a human posted the approved reply manually (GBP API approval
 * pending — there is no auto-post). Sets responded=true and annotates the
 * approval item with the honest limitation note.
 */
export async function recordManualPost(
  workspaceId: string,
  reviewId: string,
  opts?: { approvalId?: string; postedBy?: string },
): Promise<Review> {
  const review = await prisma.review.findFirst({
    where: { id: reviewId, project: { workspaceId } },
  });
  if (!review) throw new ResponderError("not_found", "Review not found in this workspace");

  if (opts?.approvalId) {
    await prisma.approvalItem.updateMany({
      where: { id: opts.approvalId, workspaceId, kind: "review_response" },
      data: {
        status: "approved",
        decidedBy: opts.postedBy ?? null,
        decidedAt: new Date(),
        note: "Posted manually by operator — GBP API approval pending; no automated Google post was made.",
      },
    });
  }

  return prisma.review.update({
    where: { id: review.id },
    data: { responded: true },
  });
}
