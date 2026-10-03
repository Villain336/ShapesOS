// ShapesOS — outbound webhook delivery queue drain (Phase 4a).
// POST /api/cron/webhooks
//
// Auth (either), same pattern as the other /api/cron/* routes (lib/cron/gate):
//   1. Signed-in session (editor+) — drains the user's workspace only.
//   2. Cron: Authorization: Bearer <CRON_SECRET> — drains every workspace
//      whose plan includes webhooks. Schedule every minute (see DEPLOY.md):
//      retries are due on a 1m / 4m / 16m … backoff.
// Bounded per call (200 attempts); delivered/dead rows older than 30 days
// are pruned on the way.

import type { NextRequest } from "next/server";
import { cronGate } from "@/lib/cron/gate";
import { deliverDue } from "@/lib/webhooks/dispatch";
import { errorResponse } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const gate = await cronGate(req);
  if (gate instanceof Response) return gate;
  try {
    const summary = await deliverDue({ workspaceId: gate.isCron ? null : gate.workspaceId });
    return Response.json(gate.isCron ? summary : { workspaceId: gate.workspaceId, ...summary });
  } catch (err) {
    return errorResponse(err, "POST /api/cron/webhooks");
  }
}
