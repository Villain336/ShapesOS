// Marketr — POST /api/authority/webhooks/gbp
//
// Fake GBP Pub/Sub new-review notifications: signature-verified, idempotent.
// No session guard (webhooks authenticate by signature).
// Pipeline: verify → dedupe (message id + review unique constraint) →
// intake (sentiment + guardrails + draft) → review_queue → velocity bump.

import { z } from "zod";
import { badRequest, safetyError } from "@/app/api/authority/_lib";
import { authorityTablesReady } from "@/lib/authority/db";
import {
  intakeReview,
  verifyWebhookSignature,
  createIntakeIdempotencyLedger,
} from "@/lib/authority/reviews/intake";
import { upsertQueueItem, recordVelocityReceived, getQueueItemByReview } from "@/lib/authority/reviews/service";
import { authorityAudit } from "@/lib/authority/db";

export const dynamic = "force-dynamic";

const ledger = createIntakeIdempotencyLedger();

const ReviewSchema = z.object({
  reviewId: z.string().min(1),
  locationRef: z.string().min(1),
  source: z.enum(["gbp", "apple", "bing", "yelp", "facebook"]),
  rating: z.number().int().min(1).max(5),
  text: z.string().default(""),
  reviewerName: z.string().optional(),
});

const WebhookSchema = z.object({
  workspaceId: z.string().min(1),
  messageId: z.string().min(1),
  review: ReviewSchema,
});

export async function POST(req: Request) {
  if (!(await authorityTablesReady().catch(() => false))) {
    return Response.json({ error: "Authority tables not provisioned." }, { status: 503 });
  }

  const rawBody = await req.text();
  const signature = req.headers.get("x-marketr-signature");
  if (!verifyWebhookSignature(rawBody, signature)) {
    return Response.json({ error: "Invalid webhook signature." }, { status: 401 });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return badRequest("Invalid JSON payload.");
  }
  const body = WebhookSchema.safeParse(parsed);
  if (!body.success) return badRequest("Invalid webhook payload.", body.error.issues);

  const { workspaceId, messageId, review } = body.data;

  // Idempotency: message-level first, then the DB unique constraint.
  const msgKey = `${workspaceId}|${messageId}`;
  if (ledger.seenKey(msgKey)) {
    return Response.json({ deduped: true, reason: "message already processed" });
  }

  try {
    const intake = intakeReview({
      workspaceId,
      messageId,
      review: {
        reviewId: review.reviewId,
        locationRef: review.locationRef,
        source: review.source,
        rating: review.rating,
        text: review.text,
        reviewerName: review.reviewerName ?? null,
      },
    });

    const alreadyQueued = await getQueueItemByReview(workspaceId, review.source, review.reviewId);
    const queueItem = await upsertQueueItem({
      workspaceId,
      intake,
      reviewText: review.text || null,
      reviewerName: review.reviewerName ?? null,
    });
    const created = !alreadyQueued;

    if (created) {
      await recordVelocityReceived(workspaceId, review.locationRef).catch(() => null);
      await authorityAudit
        .logAsync({
          workspaceId,
          actor: "gbp-webhook",
          action: "review_intaked",
          entityType: "review_queue",
          entityId: queueItem.id,
          detail: {
            reviewId: review.reviewId,
            sentiment: intake.sentiment,
            urgency: intake.urgency,
            guardrailFlags: intake.guardrailFlags,
            draftBlocked: intake.draftBlocked,
          },
        })
        .catch(() => null);
    }

    ledger.markSeen(msgKey);
    return Response.json({
      deduped: !created,
      queueItemId: queueItem.id,
      sentiment: queueItem.sentiment,
      urgency: intake.urgency,
      draftBlocked: intake.draftBlocked,
      guardrailFlags: queueItem.guardrailFlags,
    });
  } catch (e) {
    return safetyError(e);
  }
}
