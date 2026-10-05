// ShapesOS — outbound webhook delivery log (Phase 4a). Admin+ only.
// GET /api/workspace/webhooks/deliveries?endpointId&status&limit&before
//   → { deliveries } newest first (payload, attempts, last response excerpt).

import type { NextRequest } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { parseQuery } from "@/lib/api/validate";
import { DeliveryQuerySchema, listDeliveries } from "@/lib/webhooks/endpoints";
import { webhookAdmin } from "../_lib";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const ctx = await webhookAdmin();
    const q = parseQuery(DeliveryQuerySchema, req.nextUrl.searchParams);
    if (!q.ok) return q.error;
    return Response.json({ deliveries: await listDeliveries(ctx.workspaceId, q.data) });
  } catch (err) {
    return errorResponse(err, "GET /api/workspace/webhooks/deliveries");
  }
}
