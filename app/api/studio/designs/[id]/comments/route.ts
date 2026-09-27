// Marketr — studio designs: comments (Feature 6). Workspace-internal; the
// public share page renders them read-only.
// GET  /api/studio/designs/[id]/comments — list (newest last)
// POST /api/studio/designs/[id]/comments — create { body, elementId?, x?, y? }

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { guardWorkspace, httpErrorResponse, readJson } from "../../_lib";
import { HttpError } from "@/lib/enrichment/guard";

export const dynamic = "force-dynamic";

const CreateSchema = z.object({
  body: z.string().trim().min(1).max(2000),
  elementId: z.string().trim().min(1).max(64).optional(),
  x: z.number().finite().optional(),
  y: z.number().finite().optional(),
});

function serialize(c: {
  id: string;
  authorName: string;
  body: string;
  elementId: string | null;
  x: number | null;
  y: number | null;
  resolvedAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: c.id,
    authorName: c.authorName,
    body: c.body,
    elementId: c.elementId,
    x: c.x,
    y: c.y,
    resolved: c.resolvedAt !== null,
    createdAt: c.createdAt.toISOString(),
  };
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
    const { id } = await ctx.params;
  try {
    const { workspace } = await guardWorkspace();
    const design = await prisma.design.findFirst({
      where: { id: id, workspaceId: workspace.id },
      select: { id: true },
    });
    if (!design) throw new HttpError(404, "Design not found");
    const comments = await prisma.designComment.findMany({
      where: { designId: id, workspaceId: workspace.id },
      orderBy: { createdAt: "asc" },
    });
    return Response.json({ comments: comments.map(serialize) });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
    const { id } = await ctx.params;
  try {
    const { user, workspace } = await guardWorkspace();
    const design = await prisma.design.findFirst({
      where: { id: id, workspaceId: workspace.id },
      select: { id: true },
    });
    if (!design) throw new HttpError(404, "Design not found");
    const parsed = CreateSchema.safeParse(await readJson(req));
    if (!parsed.success) {
      return Response.json(
        { error: "Invalid input", issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const authorName =
      (user.name as string | undefined) ??
      (user.email as string | undefined) ??
      "Team member";
    const comment = await prisma.designComment.create({
      data: {
        designId: id,
        workspaceId: workspace.id,
        authorName: authorName.slice(0, 120),
        authorEmail: (user.email as string | undefined) ?? null,
        body: parsed.data.body,
        elementId: parsed.data.elementId ?? null,
        x: parsed.data.x ?? null,
        y: parsed.data.y ?? null,
      },
    });
    return Response.json({ comment: serialize(comment) }, { status: 201 });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
