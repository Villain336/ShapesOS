// ShapesOS — send a test event to one webhook endpoint (Phase 4a). Admin+.
// POST /api/workspace/webhooks/endpoints/[id]/test
//   → { deliveryId, outcome }  Queues a signed `webhook.ping` and attempts it
//     right away; a failed attempt stays in the queue with normal retries.

import type { NextRequest } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { queueTestEvent } from "@/lib/webhooks/endpoints";
import { deliverNow } from "@/lib/webhooks/dispatch";
import { webhookAdmin } from "../../../_lib";

export const dynamic = "force-dynamic";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await webhookAdmin();
    const { id } = await params;
    const deliveryId = await queueTestEvent(ctx.workspaceId, id);
    const outcome = await deliverNow(ctx.workspaceId, deliveryId);
    return Response.json({ deliveryId, outcome });
  } catch (err) {
    return errorResponse(err, "POST /api/workspace/webhooks/endpoints/[id]/test");
  }
}
