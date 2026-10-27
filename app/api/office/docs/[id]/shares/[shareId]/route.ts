// ShapesOS — revoke one Office doc share link (editor+). Revocation is
// immediate: the public route resolves only live links.

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { revokeDocShare } from "@/lib/sharing/doc-shares";

export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string; shareId: string }> }) {
  try {
    const { user, workspace } = await guardWorkspace({ editor: true });
    const { id, shareId } = await ctx.params;
    try {
      await revokeDocShare(workspace.id, id, shareId, user.id);
      return Response.json({ ok: true });
    } catch (err) {
      if (err instanceof Error && err.message === "SHARE_NOT_FOUND") {
        return Response.json({ error: "Share link not found" }, { status: 404 });
      }
      throw err;
    }
  } catch (e) {
    return httpErrorResponse(e);
  }
}
