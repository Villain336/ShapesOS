// Marketr — GET /api/integrations/activepieces/runs/:runId (Phase 12, Worker 3).
// Poll a flow run's status until terminal. Honest 503 when not connected.

import { getFlowRun } from "@/lib/integrations/activepieces";
import { integrationsGuard, badRequest, engineError } from "../../_lib";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const gate = await integrationsGuard("viewer");
  if (gate instanceof Response) return gate;
  const { runId } = await params;
  if (!runId) return badRequest("runId is required.");
  try {
    const run = await getFlowRun(runId);
    return Response.json({ configured: true, run });
  } catch (e) {
    return engineError(e);
  }
}
