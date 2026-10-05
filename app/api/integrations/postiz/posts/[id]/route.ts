// Marketr — Postiz sidecar: delete a post (Phase 12).
// DELETE /api/integrations/postiz/posts/[id] → { ok: true }

import { guardWorkspace, sidecarError } from "../../../_lib";
import { deletePostizPost } from "@/lib/integrations/postiz";
import { sidecarScoped } from "@/lib/integrations/sidecar-scope";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function handleDELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await guardWorkspace({ editor: true });
    const { id } = await ctx.params;
    await deletePostizPost(id);
    return Response.json({ ok: true });
  } catch (e) {
    return sidecarError(e);
  }
}

// Phase 15.1: run in this workspace's sidecar scope — its own instance;
// a shared one is refused on hosted (lib/integrations/sidecar-tenancy.ts).
export const DELETE = sidecarScoped(handleDELETE);
