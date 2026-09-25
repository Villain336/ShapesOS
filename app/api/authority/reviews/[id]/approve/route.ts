// Marketr — POST /api/authority/reviews/:id/approve
//
// Human approves (optionally edits) a draft reply. This creates + submits a
// review_reply_post approval bound to the EXACT reply payload and records the
// caller as approver #1. A second distinct approver calls the same endpoint
// to reach "approved" (two-person rule). Editing the draft after submission
// is blocked — the binding would no longer match.

import type { NextRequest } from "next/server";
import { z } from "zod";
import { authorityGuard, badRequest, safetyError, readJson } from "@/app/api/authority/_lib";
import { authorityApprovals, authorityAudit, authorityTablesReady } from "@/lib/authority/db";
import {
  getQueueItem,
  approvalForQueueItem,
} from "@/lib/authority/reviews/service";
import { replyApprovalInput } from "@/lib/authority/reviews/queue";
import { approvalSecret } from "@/lib/authority/reviews/gbpClient";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const ApproveSchema = z.object({
  draftReply: z.string().min(1).max(4000).optional(),
});

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const gate = await authorityGuard("editor");
  if (gate instanceof Response) return gate;
  if (!(await authorityTablesReady().catch(() => false))) {
    return Response.json({ error: "Authority tables not provisioned." }, { status: 503 });
  }
  const { id } = await ctx.params;
  const parsed = ApproveSchema.safeParse(await readJson(req));
  if (!parsed.success) return badRequest("Invalid input", parsed.error.issues);

  try {
    const item = await getQueueItem(id, gate.workspaceId);
    if (!item) return Response.json({ error: "Review not found in workspace." }, { status: 404 });
    if (item.status === "posted") return badRequest("Reply already posted — duplicates are blocked.");
    if (item.guardrailFlags.includes("pii_detected") || item.guardrailFlags.includes("incentive_language")) {
      return badRequest(
        "Draft is hard-blocked by guardrails (pii_detected / incentive_language). The reply must be rewritten by a human.",
      );
    }

    const draftReply = parsed.data.draftReply ?? item.draftReply;
    if (!draftReply) return badRequest("No draft reply to approve — the draft is blocked or empty.");

    const existing = await approvalForQueueItem(gate.workspaceId, item.id);

    if (!existing) {
      // First approval: create + submit + record approver #1.
      const input = replyApprovalInput({
        workspaceId: gate.workspaceId,
        createdBy: gate.userId,
        queueItem: { id: item.id, reviewId: item.reviewId, locationRef: item.locationRef, source: item.source },
        replyText: draftReply,
      });
      const created = await authorityApprovals.create(input);
      const submitted = await authorityApprovals.submit(created.id, gate.workspaceId, gate.userId);
      const signed = await authorityApprovals.approve(created.id, gate.workspaceId, gate.userId, approvalSecret());
      if (draftReply !== item.draftReply) {
        await prisma.reviewQueue.update({ where: { id: item.id }, data: { draftReply } });
      }
      await authorityAudit.logAsync({
        workspaceId: gate.workspaceId,
        actor: gate.userId,
        action: "review_reply_approval_created",
        entityType: "review_queue",
        entityId: item.id,
        detail: { approvalId: created.id, approvers: signed.approvers, status: signed.status },
      });
      return Response.json({
        approval: signed,
        needsSecondApprover: signed.status === "pending",
        queueItem: await getQueueItem(id, gate.workspaceId),
      });
    }

    // Second distinct approver.
    if (existing.status !== "pending") {
      return badRequest(`Approval is ${existing.status} — cannot sign.`);
    }
    if (parsed.data.draftReply && parsed.data.draftReply !== (existing.bindingJson as Record<string, unknown>).replyText) {
      return badRequest(
        "Draft is locked after submission — editing would break the approval binding. Reject/revoke the approval and re-approve to change the text.",
      );
    }
    const signed = await authorityApprovals.approve(existing.id, gate.workspaceId, gate.userId, approvalSecret());
    if (signed.status === "approved") {
      await prisma.reviewQueue.update({ where: { id: item.id }, data: { status: "approved" } });
    }
    await authorityAudit.logAsync({
      workspaceId: gate.workspaceId,
      actor: gate.userId,
      action: "review_reply_approval_signed",
      entityType: "review_queue",
      entityId: item.id,
      detail: { approvalId: existing.id, approvers: signed.approvers, status: signed.status },
    });
    return Response.json({
      approval: signed,
      needsSecondApprover: signed.status === "pending",
      queueItem: await getQueueItem(id, gate.workspaceId),
    });
  } catch (e) {
    return safetyError(e);
  }
}
