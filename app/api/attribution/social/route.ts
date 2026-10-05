// ShapesOS — Attribution API: social posts (Phase 4b).
// GET /api/attribution/social?model=linear|first_touch|last_touch&from=&to=&pipelineId=
// Engagement per post/campaign (social_post_metrics) joined with the leads
// and revenue their UTM-tagged links brought in (social_organic touches).

import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { resolveWindow } from "@/lib/attribution/report";
import { isAttributionModel, type AttributionModel } from "@/lib/attribution/models";
import { getSocialAttribution } from "@/lib/attribution/social";
import { errorResponse } from "@/lib/api/errors";

export async function GET(req: Request) {
  try {
    const user = await requireUser();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const workspace = await getOrCreateWorkspace(user.id, user.email);
    const sp = new URL(req.url).searchParams;
    const modelParam = sp.get("model");
    const model: AttributionModel = isAttributionModel(modelParam) ? modelParam : "linear";
    const win = await resolveWindow(workspace.id, sp);
    if (!win.ok) return Response.json({ error: win.error }, { status: 400 });
    return Response.json(await getSocialAttribution(workspace.id, win.window, model));
  } catch (e) {
    return errorResponse(e, "attribution/social", req);
  }
}
