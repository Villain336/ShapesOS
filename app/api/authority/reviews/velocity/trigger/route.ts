// Marketr — POST /api/authority/reviews/velocity/trigger
//
// Smart-timing review request: CRM/POS transaction webhook → request inside
// one of Google's four documented channels ONLY (receipt, thank-you email,
// end-of-chat, in-store QR). Any other channel is a hard 400.
//
// { locationRef, channel, customerRef (hashed), transactionId? }
// → updated velocity snapshot (velocity_7d/30d, funnel).

import { z } from "zod";
import { authorityGuard, badRequest, safetyError, readJson } from "@/app/api/authority/_lib";
import { authorityTablesReady, authorityAudit } from "@/lib/authority/db";
import { recordVelocityTrigger } from "@/lib/authority/reviews/service";
import { REVIEW_REQUEST_CHANNELS } from "@/lib/authority/reviews/types";

export const dynamic = "force-dynamic";

const TriggerSchema = z.object({
  locationRef: z.string().min(1).max(200),
  channel: z.enum(REVIEW_REQUEST_CHANNELS),
  customerRef: z.string().min(1).max(200),
  transactionId: z.string().max(200).optional(),
});

export async function POST(req: Request) {
  const gate = await authorityGuard("editor");
  if (gate instanceof Response) return gate;
  if (!(await authorityTablesReady().catch(() => false))) {
    return Response.json({ error: "Authority tables not provisioned." }, { status: 503 });
  }

  const parsed = TriggerSchema.safeParse(await readJson(req));
  if (!parsed.success) {
    return badRequest(
      `Invalid trigger. Channel must be one of Google's documented review-request channels: ${REVIEW_REQUEST_CHANNELS.join(", ")}.`,
      parsed.error.issues,
    );
  }

  try {
    const row = await recordVelocityTrigger({
      workspaceId: gate.workspaceId,
      locationRef: parsed.data.locationRef,
      channel: parsed.data.channel,
      customerRef: parsed.data.customerRef,
    });
    await authorityAudit
      .logAsync({
        workspaceId: gate.workspaceId,
        actor: gate.userId,
        action: "review_request_triggered",
        entityType: "review_velocity",
        entityId: row.id,
        detail: {
          locationRef: row.locationRef,
          channel: parsed.data.channel,
          transactionId: parsed.data.transactionId ?? null,
        },
      })
      .catch(() => null);
    return Response.json({
      locationRef: row.locationRef,
      requestsSent: row.requestsSent,
      reviewsReceived: row.reviewsReceived,
      velocity7d: row.velocity7d,
      velocity30d: row.velocity30d,
      funnel: row.funnelJson,
    });
  } catch (e) {
    return safetyError(e);
  }
}
