// Marketr — Phase 8 G1: ER decision API.
// POST /api/substrate/graph/er-queue/:id/resolve { decision, workspaceId }
// Human-only (editor+). Approve → reversible SAME_AS merge; reject → NOT_SAME
// negative signal. No auto-merge exists anywhere in v1.

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { workspaceIdFrom, requireWorkspaceAccess, badRequest } from "@/lib/route-utils";
import { resolveErItem, revertMerge } from "@/lib/substrate/graph/merges";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as {
    workspaceId?: string;
    decision?: string;
    revert?: boolean;
  } | null;
  const access = await requireWorkspaceAccess(user.id, workspaceIdFrom(req, body), "editor");
  if ("error" in access) return access.error;
  const { id } = await ctx.params;

  if (body?.revert) {
    // Revert a merge: body.nodeId = the absorbed node.
    const nodeId = (body as { nodeId?: string }).nodeId;
    if (!nodeId) return badRequest("nodeId is required for revert");
    await revertMerge(access.workspaceId, nodeId, user.id);
    return Response.json({ reverted: true });
  }

  if (body?.decision !== "approved" && body?.decision !== "rejected") {
    return badRequest("decision must be approved|rejected");
  }
  const result = await resolveErItem(access.workspaceId, id, body.decision, user.id);
  return Response.json(result);
}
