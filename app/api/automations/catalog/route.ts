// ShapesOS — Phase 18.3 (WS=flow): GET /api/automations/catalog → { triggers, actions }
// The one trigger catalogue and one action catalogue (every agent tool with
// its tier), generated from the registries (lib/automations/catalog.ts). Viewer+.

import { errorResponse } from "@/lib/api/errors";
import { flowGuard } from "../_lib";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const ctx = await flowGuard("viewer");
    if (ctx instanceof Response) return ctx;
    // Lazy: the action catalogue walks the whole agent tool registry.
    const { actionCatalog, triggerCatalog } = await import("@/lib/automations/catalog");
    return Response.json({ triggers: triggerCatalog(), actions: actionCatalog() }, { headers: { "Cache-Control": "private, max-age=300" } });
  } catch (err) {
    return errorResponse(err, "GET /api/automations/catalog", req);
  }
}
