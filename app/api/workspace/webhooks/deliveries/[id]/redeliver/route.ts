// ShapesOS — redeliver a webhook (Phase 4a). Admin+ only.
// POST /api/workspace/webhooks/deliveries/[id]/redeliver
//   → { deliveryId, outcome }  A new delivery row with the same event id and
//     payload (receivers dedupe on the event id), attempted right away.

import type { NextRequest } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { redeliver } from "@/lib/webhooks/endpoints";
import { deliverNow } from "@/lib/webhooks/dispatch";
import { webhookAdmin } from "../../../_lib";

export const dynamic = "force-dynamic";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await webhookAdmin();
    const { id } = await params;
    const deliveryId = await redeliver(ctx.workspaceId, id);
    const outcome = await deliverNow(ctx.workspaceId, deliveryId);
    return Response.json({ deliveryId, outcome });
  } catch (err) {
    return errorResponse(err, "POST /api/workspace/webhooks/deliveries/[id]/redeliver");
  }
}
