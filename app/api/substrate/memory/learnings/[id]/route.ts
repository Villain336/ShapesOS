// Marketr — PATCH /api/substrate/memory/learnings/[id] (Phase 8 G3).
// { invalidate: true, reason? } — invalidate a learning (editor). Invalidated
// rows stay in history and can still be recalled with includeInvalidated or
// temporal queries — they are never deleted.
// { accept: true } — a human accepts an agent-inferred lesson (editor); only
// accepted inferences are recalled into model prompts (memory poisoning).

import type { NextRequest } from "next/server";
import { memoryGuard, badRequest, readJson, memoryAudit } from "../../_lib";
import { acceptLearning, invalidateLearning } from "@/lib/substrate/memory/write";

export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const gate = await memoryGuard(req, "editor");
  if (gate instanceof Response) return gate;
  const { id } = await ctx.params;
  const body = await readJson(req);
  if (body.accept === true) {
    let acceptedAt: string;
    try {
      ({ acceptedAt } = await acceptLearning(gate.workspaceId, id, gate.userId));
    } catch {
      return Response.json({ error: "Learning not found." }, { status: 404 });
    }
    memoryAudit().log(gate.workspaceId, gate.userId, "learning.accepted", id, { acceptedAt });
    return Response.json({ id, accepted: true, acceptedAt });
  }
  if (body.invalidate !== true) {
    return badRequest("body must be { invalidate: true, reason? } or { accept: true }");
  }
  const reason = body.reason != null ? String(body.reason).slice(0, 500) : "manual invalidation via API";
  try {
    await invalidateLearning(gate.workspaceId, id, reason);
  } catch {
    return Response.json({ error: "Learning not found." }, { status: 404 });
  }
  memoryAudit().log(gate.workspaceId, gate.userId, "learning.invalidated", id, { reason });
  return Response.json({ id, invalidated: true });
}
