// Marketr — POST /api/authority/reviews/:id/post
//
// Posts an approved reply to GBP. HARD RULE: requires an approved
// review_reply_post approval whose binding re-verifies against the exact
// payload (binding mismatch HALTS execution). Posting without approval is
// structurally impossible here — there is no other code path.
// Every post is audit-logged; ReviewReplyState is polled, never assumed.

import type { NextRequest } from "next/server";
import { authorityGuard, safetyError } from "@/app/api/authority/_lib";
import { authorityApprovals, authorityAudit, authorityTablesReady } from "@/lib/authority/db";
import { getQueueItem, approvalForQueueItem } from "@/lib/authority/reviews/service";
import { assertPostable } from "@/lib/authority/reviews/queue";
import { gbpClientForWorkspace } from "@/lib/authority/reviews/gbpClient";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const gate = await authorityGuard("editor");
  if (gate instanceof Response) return gate;
  if (!(await authorityTablesReady().catch(() => false))) {
    return Response.json({ error: "Authority tables not provisioned." }, { status: 503 });
  }
  const { id } = await ctx.params;

  try {
    const item = await getQueueItem(id, gate.workspaceId);
    if (!item) return Response.json({ error: "Review not found in workspace." }, { status: 404 });

    const approval = await approvalForQueueItem(gate.workspaceId, item.id);
    if (!approval) {
      return safetyError(
        new Error("No review_reply_post approval for this reply — v1 posts nothing without approval."),
      );
    }
    assertPostable(
      {
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
      approval.status,
    );

    // Execute re-verifies the exact binding and HALTS on mismatch.
    const payload = approval.bindingJson as Record<string, unknown>;
    const executed = await authorityApprovals.execute(approval.id, gate.workspaceId, payload);

    const replyText = payload.replyText as string;
    const gbp = await gbpClientForWorkspace(gate.workspaceId);
    await gbp.updateReply(item.locationRef, item.reviewId, replyText);

    const updated = await prisma.reviewQueue.update({
      where: { id: item.id },
      data: { status: "posted", replyState: "pending_mod", postedAt: new Date() },
    });

    await authorityAudit.logAsync({
      workspaceId: gate.workspaceId,
      actor: gate.userId,
      action: "review_reply_posted",
      entityType: "review_queue",
      entityId: item.id,
      detail: {
        approvalId: approval.id,
        reviewId: item.reviewId,
        locationRef: item.locationRef,
        replyState: "PENDING",
        gbpClient: gbp.name,
      },
    });

    return Response.json({
      queueItem: updated,
      approvalStatus: executed.status,
      replyState: "PENDING",
      note: "Reply submitted to GBP pre-publication moderation. Poll /reply-state — never assume delivery.",
    });
  } catch (e) {
    return safetyError(e);
  }
}
