// ShapesOS — Phase 19A (WS=server): POST /api/cursor/agent
// { goal, maxUsd, conversationId? } → { runId, maxUsd }.
// Starts the lead agent on `goal` in the background (a Phase 16 run that can
// delegate) with AgentRun.budgetMicroUsd = maxUsd — enforced before every
// model call and in the delegation split (lib/cursor/agent.ts). maxUsd is
// validated server-side (> 0, ≤ the plan's ceiling). Progress: GET
// /api/agent-runs/[runId]/watch. Editor+ only (requireWorkspaceRole).
// Rate limit: the "ai" tier (proxy.ts).

import { requireWorkspaceRole } from "@/lib/authz";
import { CursorHttpError, cursorErrorResponse, forbiddenCursor, readCursorJson, resolveCursorCaller } from "@/lib/cursor/http";
import { AgentBodySchema } from "@/lib/cursor/validate";
import { startCursorAgent } from "@/lib/cursor/agent";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const caller = await resolveCursorCaller(req);
    if (!(await requireWorkspaceRole(caller.userId, caller.workspaceId, "editor"))) throw forbiddenCursor("Viewers can't start background tasks.");
    const parsed = AgentBodySchema.safeParse(await readCursorJson(req, 16 * 1024));
    if (!parsed.success) throw new CursorHttpError(400, "bad_request", "Send { goal, maxUsd }.");
    const out = await startCursorAgent({ workspaceId: caller.workspaceId, userId: caller.userId, role: caller.role, ...parsed.data });
    return Response.json(out);
  } catch (err) {
    return cursorErrorResponse(err);
  }
}
