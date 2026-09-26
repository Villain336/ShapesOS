// Marketr — /api/playbooks/:id (Phase 9 M5).
// GET: { playbook, versions } — versions carry labels + eval summaries.

import { playbooksGuard, storeError } from "../_lib";
import { getPlaybook } from "@/lib/playbooks/store";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await playbooksGuard("viewer");
  if (gate instanceof Response) return gate;
  const { id } = await ctx.params;
  try {
    const result = await getPlaybook(gate.workspaceId, id);
    if (!result) return Response.json({ error: "Playbook not found." }, { status: 404 });
    return Response.json(result);
  } catch (err) {
    return storeError(err);
  }
}
