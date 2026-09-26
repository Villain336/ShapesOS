// Marketr — /api/playbooks/:id/versions (Phase 9 M5).
// POST (editor): { content } → new immutable version (version = max+1, status draft).

import { playbooksGuard, badRequest, readJson, storeError } from "../../_lib";
import { createVersion } from "@/lib/playbooks/store";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await playbooksGuard("editor");
  if (gate instanceof Response) return gate;
  const { id } = await ctx.params;
  const body = await readJson(req);
  if (!body.content || typeof body.content !== "object") {
    return badRequest("content is required (object with a steps array).");
  }
  try {
    const created = await createVersion(
      gate.workspaceId,
      id,
      body.content as never,
      gate.userId,
    );
    return Response.json(created, { status: 201 });
  } catch (err) {
    return storeError(err);
  }
}
