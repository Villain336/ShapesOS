// ShapesOS — outbound webhook endpoints (Phase 4a). Admin+ only.
// GET  /api/workspace/webhooks/endpoints → { endpoints, eventTypes, entitled }
// POST /api/workspace/webhooks/endpoints { url, description?, events? }
//        → { endpoint, secret }   (the signing secret is shown ONCE)
// Plan-gated (webhooks entitlement → 403 + upgrade message).

import type { NextRequest } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { planHasFeature } from "@/lib/billing/entitlements";
import { createEndpoint, listEndpoints } from "@/lib/webhooks/endpoints";
import { SUBSCRIBABLE_EVENT_TYPES, WEBHOOK_EVENT_LABELS } from "@/lib/webhooks/events";
import { webhookAdmin } from "../_lib";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const ctx = await webhookAdmin();
    return Response.json({
      endpoints: await listEndpoints(ctx.workspaceId),
      eventTypes: SUBSCRIBABLE_EVENT_TYPES.map((t) => ({ type: t, label: WEBHOOK_EVENT_LABELS[t] })),
      entitled: planHasFeature(ctx.plan, "webhooks"),
    });
  } catch (err) {
    return errorResponse(err, "GET /api/workspace/webhooks/endpoints");
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await webhookAdmin();
    const body = await req.json();
    const { endpoint, secret } = await createEndpoint(ctx.workspaceId, ctx.userId, body);
    return Response.json({ endpoint, secret }, { status: 201 });
  } catch (err) {
    return errorResponse(err, "POST /api/workspace/webhooks/endpoints");
  }
}
