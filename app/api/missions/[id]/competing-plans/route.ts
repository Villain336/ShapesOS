// ShapesOS - /api/missions/:id/competing-plans
// GET  -> whether independent competing plans can run (viewer+). Never calls a model.
// POST -> (editor+) ask for independent candidate plans. HARD DEFAULT-OFF: unless the
//         operator sets COMPETING_PLANS_ENABLED=1 and a COMPETING_PLANS_CAP_MICRO_USD
//         ceiling, this refuses before any mission read or model call. Candidates are
//         returned for a person to read; nothing is written to the mission.
//         Provider usage metering for this route is NOT wired; it must be before the
//         flag is turned on (see PR notes).

import { missionsGuard, safetyError, missionDeps } from "../../_lib";
import { loadMission } from "@/lib/missions/engine";
import { competingPlansGate } from "@/lib/missions/competing-plans-gate";
import { composeCandidates, CompetingPlansRefused } from "@/lib/missions/competing-plans";
import { getLlmProvider, llmStatus } from "@/lib/llm";

export const dynamic = "force-dynamic";

const MAX_TOKENS_PER_CALL = 1500;

export async function GET() {
  const gate = await missionsGuard("viewer");
  if (gate instanceof Response) return gate;
  const g = competingPlansGate();
  return Response.json({ enabled: g.enabled, reason: g.reason });
}

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await missionsGuard("editor");
  if (gate instanceof Response) return gate;
  const g = competingPlansGate();
  if (!g.enabled || g.capMicroUsd === null) return Response.json({ error: g.reason, enabled: false }, { status: 403 });
  const { id } = await params;
  try {
    const deps = missionDeps();
    if (await deps.isWorkspaceFrozen(gate.workspaceId)) return Response.json({ error: "Workspace is frozen." }, { status: 423 });
    const { mission } = await loadMission(deps, id, gate.workspaceId);
    if (mission.status !== "planned") return Response.json({ error: "Competing plans are only offered for a drafted (planned) mission." }, { status: 409 });
    const goal = mission.goal as { label?: unknown; metric?: unknown; targetValue?: unknown; unit?: unknown; timeframeDays?: unknown; direction?: unknown };
    const goalText = [goal.label ?? goal.metric, goal.direction, goal.targetValue, goal.unit, goal.timeframeDays ? `in ${goal.timeframeDays} days` : ""]
      .filter((x) => x !== undefined && x !== null && x !== "")
      .join(" ");
    const out = await composeCandidates({
      provider: getLlmProvider(),
      model: llmStatus().model,
      goal: goalText,
      maxTokensPerCall: MAX_TOKENS_PER_CALL,
      capMicroUsd: g.capMicroUsd,
    });
    return Response.json({ ceilingMicroUsd: out.ceilingMicroUsd, ceilingNote: "A conservative ceiling, not a forecast or a charge.", results: out.results });
  } catch (err) {
    if (err instanceof CompetingPlansRefused) return Response.json({ error: err.message, code: err.code }, { status: err.code === "bad_input" ? 400 : 409 });
    return safetyError(err);
  }
}
