// Marketr — Attribution API: revenue-influenced content.
// GET /api/attribution/content?model=linear&from=&to=
// Touches carrying a contentId (a Marketr ContentItem page) are credited with
// the revenue they touched, under the selected model.

import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { getContentReport, resolveWindow } from "@/lib/attribution/report";
import { isAttributionModel, type AttributionModel } from "@/lib/attribution/models";

export async function GET(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);

  const sp = new URL(req.url).searchParams;
  const modelParam = sp.get("model");
  const model: AttributionModel = isAttributionModel(modelParam) ? modelParam : "linear";
  const win = await resolveWindow(workspace.id, sp);
  if (!win.ok) return Response.json({ error: win.error }, { status: 400 });

  const items = await getContentReport(workspace.id, win.window, model);
  return Response.json({ model, items });
}
