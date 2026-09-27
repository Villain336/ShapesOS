// Marketr — POST /api/integrations/activepieces/flows/:flowId/trigger (Phase 12, Worker 3).
// Fire a published webhook-trigger flow with a JSON payload. Editor+ only.
// The engine's webhook path needs no key — Marketr still gates on role and
// runs the trigger pre-flight (only webhook triggers can fire externally).

import { triggerFlow } from "@/lib/integrations/activepieces";
import { integrationsGuard, badRequest, engineError } from "../../../_lib";

export const dynamic = "force-dynamic";

const MAX_PAYLOAD_BYTES = 256 * 1024;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ flowId: string }> },
) {
  const gate = await integrationsGuard("editor");
  if (gate instanceof Response) return gate;
  const { flowId } = await params;
  if (!flowId) return badRequest("flowId is required.");

  let payload: Record<string, unknown> = {};
  try {
    const raw = await req.text();
    if (raw.length > MAX_PAYLOAD_BYTES) return badRequest("Payload exceeds 256KB.");
    if (raw.trim().length > 0) {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return badRequest("Payload must be a JSON object.");
      }
      payload = parsed as Record<string, unknown>;
    }
  } catch {
    return badRequest("Payload must be valid JSON.");
  }

  try {
    const result = await triggerFlow(flowId, payload);
    return Response.json({
      accepted: true,
      flowId: result.flowId,
      runId: result.runId,
      note: result.runId
        ? "Flow accepted. Poll /api/integrations/activepieces/runs/:runId for status."
        : "Flow accepted. The engine did not return a run id — poll /api/integrations/activepieces/runs?flowId=… for the newest run.",
    });
  } catch (e) {
    return engineError(e);
  }
}
