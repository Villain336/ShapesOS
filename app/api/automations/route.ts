// ShapesOS — Phase 18.3 (WS=flow): GET /api/automations → { items, unavailable }
// Every automation in the current workspace across the existing systems
// (lib/automations/list.ts); system cron jobs only for admins. Viewer+.
// On/off and Run now are NOT here: each item names its own system's route.

import { errorResponse } from "@/lib/api/errors";
import { loadAutomations } from "@/lib/automations/list";
import { flowGuard } from "./_lib";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const ctx = await flowGuard("viewer");
    if (ctx instanceof Response) return ctx;
    const data = await loadAutomations(ctx);
    return Response.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err, "GET /api/automations", req);
  }
}
