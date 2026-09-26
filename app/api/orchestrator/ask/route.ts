// Marketr — POST /api/orchestrator/ask (Phase 9 M2, SPEC §P9B "Ask").
//
// Free-form question to the Chief Strategy Agent. Answered with citations
// to the Business Graph / Growth Memory. PROPOSE-ONLY: write-implying
// queries return a drafted request object, never an execution.

export const dynamic = "force-dynamic";

import { prisma } from "@/lib/prisma";
import { orchestratorGuard, badRequest, readJson } from "../_lib";
import { answerAsk } from "@/lib/orchestrator/ask";

export async function POST(req: Request) {
  const guard = await orchestratorGuard("viewer");
  if (guard instanceof Response) return guard;

  const body = await readJson(req);
  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (!query) return badRequest("query is required");
  if (query.length > 4000) return badRequest("query is too long (max 4000 characters)");

  const missionId = typeof body.missionId === "string" && body.missionId.trim() ? body.missionId.trim() : null;
  if (missionId) {
    const mission = await prisma.mission.findFirst({
      where: { id: missionId, workspaceId: guard.workspaceId },
      select: { id: true },
    });
    if (!mission) {
      return Response.json({ error: "Mission not found in workspace." }, { status: 404 });
    }
  }

  try {
    const result = await answerAsk({
      workspaceId: guard.workspaceId,
      userId: guard.userId,
      query,
      missionId,
    });
    return Response.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = /frozen|paused/i.test(message) ? 423 : 500;
    return Response.json({ error: message }, { status });
  }
}
