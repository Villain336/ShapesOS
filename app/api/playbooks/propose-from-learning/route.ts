// Marketr — /api/playbooks/propose-from-learning (Phase 9 M5).
// POST (editor): { learningId } → drafts a playbook from a memory_learnings
// row. The first version starts at status `review`: human review is required
// before it can advance. Never auto-promotes.

import { playbooksGuard, badRequest, readJson, storeError } from "../_lib";
import { proposeFromLearning } from "@/lib/playbooks/store";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const gate = await playbooksGuard("editor");
  if (gate instanceof Response) return gate;
  const body = await readJson(req);
  const learningId = typeof body.learningId === "string" ? body.learningId : "";
  if (!learningId) return badRequest("learningId is required.");
  try {
    const result = await proposeFromLearning(gate.workspaceId, learningId, gate.userId);
    return Response.json(result, { status: 201 });
  } catch (err) {
    return storeError(err);
  }
}
