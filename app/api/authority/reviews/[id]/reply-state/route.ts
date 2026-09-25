// Marketr — GET /api/authority/reviews/:id/reply-state
//
// Polls Google's ReviewReplyState (PENDING/APPROVED/REJECTED) and persists
// the result. On REJECTED: auto-sanitize + re-draft for human re-approval;
// after 2 rejections the item escalates to human-only.

import type { NextRequest } from "next/server";
import { authorityGuard, safetyError } from "@/app/api/authority/_lib";
import { authorityAudit, authorityTablesReady } from "@/lib/authority/db";
import { getQueueItem } from "@/lib/authority/reviews/service";
import { pollReplyState, MAX_AUTO_REJECTION_RETRIES } from "@/lib/authority/reviews/replyState";
import { gbpClientForRoutes } from "@/lib/authority/reviews/gbpClient";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const gate = await authorityGuard("viewer");
  if (gate instanceof Response) return gate;
  if (!(await authorityTablesReady().catch(() => false))) {
    return Response.json({ error: "Authority tables not provisioned." }, { status: 503 });
  }
  const { id } = await ctx.params;

  try {
    const item = await getQueueItem(id, gate.workspaceId);
    if (!item) return Response.json({ error: "Review not found in workspace." }, { status: 404 });
    if (item.status !== "posted") {
      return Response.json({
        replyState: item.replyState,
        pollable: false,
        note: "Nothing has been posted yet — no moderation state to poll.",
      });
    }

    const outcome = await pollReplyState({
      item: {
        id: item.id,
        workspaceId: item.workspaceId,
        locationRef: item.locationRef,
        reviewId: item.reviewId,
        source: item.source,
        rating: item.rating,
        sentiment: item.sentiment,
        reviewText: item.reviewText,
        reviewerName: item.reviewerName,
        draftReply: item.draftReply,
        guardrailFlags: item.guardrailFlags,
        status: item.status,
        replyState: item.replyState,
        postedAt: item.postedAt,
        rejectionCount: item.rejectionCount,
        createdAt: item.createdAt,
      },
      gbp: gbpClientForRoutes(),
    });

    const updated = await prisma.reviewQueue.update({
      where: { id: item.id },
      data: {
        replyState: outcome.queueItem.replyState,
        status: outcome.queueItem.status,
        rejectionCount: outcome.queueItem.rejectionCount,
        draftReply: outcome.queueItem.draftReply,
        guardrailFlags: outcome.queueItem.guardrailFlags,
      },
    });

    if (outcome.action !== "still_pending" && outcome.action !== "confirmed") {
      await authorityAudit.logAsync({
        workspaceId: gate.workspaceId,
        actor: "reply-state-poller",
        action:
          outcome.action === "escalated"
            ? "review_reply_escalated"
            : "review_reply_sanitized_redrafted",
        entityType: "review_queue",
        entityId: item.id,
        detail: {
          polled: outcome.replyState,
          rejectionCount: updated.rejectionCount,
          maxRetries: MAX_AUTO_REJECTION_RETRIES,
        },
      });
    }

    return Response.json({
      queueItem: updated,
      polled: outcome.replyState,
      action: outcome.action,
      note:
        outcome.action === "escalated"
          ? "Two moderation rejections — human-only from here. Rewrite the reply manually and re-approve."
          : outcome.action === "sanitized_redrafted"
            ? "Google rejected the reply. It was auto-sanitized and re-drafted — human re-approval required."
            : outcome.action === "confirmed"
              ? "Google approved the reply. It is live."
              : "Still in Google moderation. Poll again later.",
    });
  } catch (e) {
    return safetyError(e);
  }
}
