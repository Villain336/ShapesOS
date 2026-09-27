// Marketr — studio designs: revoke a share link (Feature 6).
// DELETE /api/studio/designs/[id]/shares/[shareId] — soft-revoke (sets
// revokedAt). The public URL 404s identically to unknown/expired tokens.

import { prisma } from "@/lib/prisma";
import { guardWorkspace, httpErrorResponse } from "../../../_lib";
import { HttpError } from "@/lib/enrichment/guard";

export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string; shareId: string }> }) {
  const { id, shareId } = await ctx.params;
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const share = await prisma.designShare.findFirst({
      where: { id: shareId, designId: id, workspaceId: workspace.id },
      select: { id: true, revokedAt: true },
    });
    if (!share) throw new HttpError(404, "Share not found");
    if (!share.revokedAt) {
      await prisma.designShare.update({
        where: { id: share.id },
        data: { revokedAt: new Date() },
      });
    }
    return Response.json({ revoked: true });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
