// Marketr — studio designs: approval workflow (Feature 6).
// GET   /api/studio/designs/[id]/approval — { status, note }
// PATCH /api/studio/designs/[id]/approval — { status, note? }
//   status: draft | in_review | approved | changes_requested

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { guardWorkspace, httpErrorResponse, readJson } from "../../_lib";
import { HttpError } from "@/lib/enrichment/guard";

export const dynamic = "force-dynamic";

const STATUSES = ["draft", "in_review", "approved", "changes_requested"] as const;

const PatchSchema = z.object({
  status: z.enum(STATUSES),
  note: z.string().trim().max(2000).optional(),
});

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
    const { id } = await ctx.params;
  try {
    const { workspace } = await guardWorkspace();
    const design = await prisma.design.findFirst({
      where: { id: id, workspaceId: workspace.id },
      select: { approvalStatus: true, approvalNote: true },
    });
    if (!design) throw new HttpError(404, "Design not found");
    return Response.json({
      status: design.approvalStatus,
      note: design.approvalNote,
    });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
    const { id } = await ctx.params;
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const parsed = PatchSchema.safeParse(await readJson(req));
    if (!parsed.success) {
      return Response.json(
        { error: "Invalid input", issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const design = await prisma.design.findFirst({
      where: { id: id, workspaceId: workspace.id },
      select: { id: true },
    });
    if (!design) throw new HttpError(404, "Design not found");
    const updated = await prisma.design.update({
      where: { id: design.id },
      data: {
        approvalStatus: parsed.data.status,
        approvalNote:
          parsed.data.status === "changes_requested" ? (parsed.data.note ?? null) : null,
      },
      select: { approvalStatus: true, approvalNote: true },
    });
    return Response.json({ status: updated.approvalStatus, note: updated.approvalNote });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
