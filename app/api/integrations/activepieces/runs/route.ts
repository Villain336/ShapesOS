// Marketr — GET /api/integrations/activepieces/runs (Phase 12, Worker 3).
// ?flowId=… → newest run for that flow. Honest 503 when not connected.

import { latestFlowRun } from "@/lib/integrations/activepieces";
import { integrationsGuard, badRequest, engineError, notConnected } from "../_lib";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const gate = await integrationsGuard("viewer");
  if (gate instanceof Response) return gate;
  const flowId = new URL(req.url).searchParams.get("flowId");
  if (!flowId) return badRequest("flowId query parameter is required.");
  try {
    const run = await latestFlowRun(flowId);
    if (run === null) {
      // latestFlowRun only returns null when the engine is unconfigured
      // (listFlows degrades) or the flow has no runs — disambiguate honestly.
      const { isActivepiecesConfigured } = await import("@/lib/integrations/activepieces");
      if (!isActivepiecesConfigured()) return notConnected();
      return Response.json({ configured: true, run: null, note: "No runs recorded for this flow yet." });
    }
    return Response.json({ configured: true, run });
  } catch (e) {
    return engineError(e);
  }
}
