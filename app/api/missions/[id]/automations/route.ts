// Marketr — POST /api/missions/:id/automations (editor+)
//
// "Run automation" action for Missions (Phase 12, Worker 3): fires a published
// Activepieces webhook flow from a mission and records the trigger + outcome
// in the mission's hash-chained event log via the M4 engine twin.
//
// The trigger runs the same preflight as the integrations API: only published
// flows with a "Catch Webhook" trigger can be fired externally. Runs are NOT
// awaited here — the engine works async; poll the run via
// /api/integrations/activepieces/runs/:runId.
//
// Payload is capped at 256KB (matches the integrations trigger route).
// Never returns key material. 503 when Activepieces is not configured.

import { missionsGuard, safetyError, missionDeps, readJson, badRequest } from "../../_lib";
import { appendStepEvent } from "@/lib/missions/engine";
import {
  isActivepiecesConfigured,
  triggerFlow,
  latestFlowRun,
} from "@/lib/integrations/activepieces";

export const dynamic = "force-dynamic";

const MAX_PAYLOAD_BYTES = 256 * 1024;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await missionsGuard("editor");
  if (gate instanceof Response) return gate;
  const { id } = await params;

  if (!isActivepiecesConfigured()) {
    return Response.json(
      {
        error: "Activepieces is not connected",
        detail:
          "Set ACTIVEPIECES_URL and ACTIVEPIECES_API_KEY on the host (Settings → Providers) to run automations. No flow was triggered.",
      },
      { status: 503 },
    );
  }

  const body = await readJson(req);
  const flowId = typeof body.flowId === "string" && body.flowId.trim() ? body.flowId.trim() : null;
  if (!flowId) return badRequest("flowId is required");

  let payload: Record<string, unknown> = {};
  if (body.payload !== undefined) {
    if (!body.payload || typeof body.payload !== "object" || Array.isArray(body.payload)) {
      return badRequest("payload must be a JSON object");
    }
    if (JSON.stringify(body.payload).length > MAX_PAYLOAD_BYTES) {
      return badRequest("payload exceeds 256KB");
    }
    payload = body.payload as Record<string, unknown>;
  }

  const deps = missionDeps();
  try {
    // Record the request FIRST: appendStepEvent asserts the mission is
    // runnable, so a paused/completed mission fails here — before any
    // external flow is fired. The trigger then never escapes the log.
    await appendStepEvent(deps, id, gate.workspaceId, {
      actor: "automation",
      step: "automation.flow_run",
      tool: "activepieces.trigger_flow",
      args: { flowId, payloadKeys: Object.keys(payload), phase: "requested" },
      observation: { flowId, requested: true, source: "mission.automations" },
      costCents: 0,
    });

    const result = await triggerFlow(flowId, payload);
    // Best-effort immediate status snapshot (webhook accept may not carry a run id).
    const latest = await latestFlowRun(flowId).catch(() => null);

    const observation: Record<string, unknown> = {
      flowId: result.flowId,
      accepted: result.accepted,
      runId: result.runId,
      runStatus: latest?.status ?? null,
      runTerminal: latest?.terminal ?? null,
      phase: "accepted",
      source: "mission.automations",
    };
    // Trigger records the event; the runner polls the run separately.
    await appendStepEvent(deps, id, gate.workspaceId, {
      actor: "automation",
      step: "automation.flow_run",
      tool: "activepieces.trigger_flow",
      args: { flowId, payloadKeys: Object.keys(payload), phase: "accepted" },
      observation,
      costCents: 0,
    });

    return Response.json({
      ok: true,
      missionId: id,
      ...observation,
      note: result.runId
        ? "Flow accepted. Poll the run via /api/integrations/activepieces/runs/:runId."
        : "Flow accepted, but the engine returned no run id — use /api/integrations/activepieces/runs?flowId=… for the newest run.",
    });
  } catch (err) {
    // A failed trigger is also worth recording on the mission timeline.
    await appendStepEvent(deps, id, gate.workspaceId, {
      actor: "automation",
      step: "automation.flow_run",
      tool: "activepieces.trigger_flow",
      args: { flowId, payloadKeys: Object.keys(payload), phase: "failed" },
      observation: {
        flowId,
        accepted: false,
        error: err instanceof Error ? err.message : String(err),
        source: "mission.automations",
      },
      costCents: 0,
    }).catch(() => {});
    return safetyError(err);
  }
}
