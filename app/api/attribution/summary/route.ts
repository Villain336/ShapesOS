// Marketr — Attribution API: KPI summary for one model.
// GET /api/attribution/summary?model=linear|first_touch|last_touch&from=&to=&pipelineId=

import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { getAttributionReport, resolveWindow } from "@/lib/attribution/report";
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

  const { report } = await getAttributionReport(workspace.id, win.window);
  const r = report[model];
  return Response.json({
    model,
    ...r.totals,
    spendByChannel: r.channels.map((c) => ({ channel: c.channel, spendCents: c.spendCents })),
  });
}
