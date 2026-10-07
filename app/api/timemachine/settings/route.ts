// ShapesOS — Phase 18.3 (WS=flow): PATCH /api/timemachine/settings { schedule?: off|daily|weekly, retention?: 1–60 }
//   → { settings }   Admin+, audited.

import { errorResponse } from "@/lib/api/errors";
import { tmSaveSettings } from "@/lib/timemachine/service";
import { flowGuard, readJsonObject } from "../../automations/_lib";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request) {
  try {
    const ctx = await flowGuard("admin");
    if (ctx instanceof Response) return ctx;
    const body = await readJsonObject(req);
    if (!body) return Response.json({ error: "Invalid JSON" }, { status: 400 });
    return Response.json({ settings: await tmSaveSettings(ctx, { schedule: body.schedule, retention: body.retention }) });
  } catch (err) {
    return errorResponse(err, "PATCH /api/timemachine/settings", req);
  }
}
