// Marketr — studio designs: resolve / delete a comment (Feature 6).
// PATCH  /api/studio/designs/[id]/comments/[commentId] — { resolved: boolean }
// DELETE /api/studio/designs/[id]/comments/[commentId]

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { guardWorkspace, httpErrorResponse, readJson } from "../../../_lib";
import { HttpError } from "@/lib/enrichment/guard";

export const dynamic = "force-dynamic";

const PatchSchema = z.object({ resolved: z.boolean() });

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string; commentId: string }> }) {
  const { id, commentId } = await ctx.params;
  try {
    const { workspace } = await guardWorkspace();
    const parsed = PatchSchema.safeParse(await readJson(req));
    if (!parsed.success) {
      return Response.json(
        { error: "Invalid input", issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const comment = await prisma.designComment.findFirst({
      where: {
        id: commentId,
        designId: id,
        workspaceId: workspace.id,
      },
      select: { id: true },
    });
    if (!comment) throw new HttpError(404, "Comment not found");
    await prisma.designComment.update({
      where: { id: comment.id },
      data: { resolvedAt: parsed.data.resolved ? new Date() : null },
    });
    return Response.json({ resolved: parsed.data.resolved });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string; commentId: string }> }) {
  const { id, commentId } = await ctx.params;
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const comment = await prisma.designComment.findFirst({
      where: {
        id: commentId,
        designId: id,
        workspaceId: workspace.id,
      },
      select: { id: true },
    });
    if (!comment) throw new HttpError(404, "Comment not found");
    await prisma.designComment.delete({ where: { id: comment.id } });
    return Response.json({ deleted: true });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
