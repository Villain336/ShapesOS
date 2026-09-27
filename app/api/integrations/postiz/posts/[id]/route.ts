// Marketr — Postiz sidecar: delete a post (Phase 12).
// DELETE /api/integrations/postiz/posts/[id] → { ok: true }

import { guardWorkspace, sidecarError } from "../../../_lib";
import { deletePostizPost } from "@/lib/integrations/postiz";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await guardWorkspace({ editor: true });
    const { id } = await ctx.params;
    await deletePostizPost(id);
    return Response.json({ ok: true });
  } catch (e) {
    return sidecarError(e);
  }
}
