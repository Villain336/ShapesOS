// Marketr — studio designs API (Phase 11 "Canvas").
// GET    /api/studio/designs/[id]  — fetch one design (workspace-scoped)
// PUT    /api/studio/designs/[id]  — rename / save document / thumbnail (editor)
// DELETE /api/studio/designs/[id]  — delete (editor)

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { validateDesignDocument } from "@/lib/design/validate";
import { guardWorkspace, httpErrorResponse, readJson } from "../_lib";

export const dynamic = "force-dynamic";

/** Thumbnail data-URL cap: 500 KB. */
export const MAX_THUMBNAIL_BYTES = 500 * 1024;

const UpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  document: z.unknown().optional(),
  thumbnail: z.string().max(MAX_THUMBNAIL_BYTES).optional(),
});

function fullDesign(row: {
  id: string;
  name: string;
  document: unknown;
  thumbnail: string | null;
  templateKey: string | null;
  brandKitId: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    name: row.name,
    document: row.document,
    thumbnail: row.thumbnail,
    templateKey: row.templateKey,
    brandKitId: row.brandKitId,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { workspace } = await guardWorkspace();
    const { id } = await ctx.params;
    const row = await prisma.design.findFirst({
      where: { id, workspaceId: workspace.id },
    });
    if (!row) return Response.json({ error: "Design not found" }, { status: 404 });
    return Response.json({ design: fullDesign(row) });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const { id } = await ctx.params;
    const existing = await prisma.design.findFirst({
      where: { id, workspaceId: workspace.id },
    });
    if (!existing) return Response.json({ error: "Design not found" }, { status: 404 });

    const parsed = UpdateSchema.safeParse(await readJson(req));
    if (!parsed.success) {
      return Response.json({ error: "Invalid input", issues: parsed.error.issues }, { status: 400 });
    }

    if (parsed.data.document !== undefined) {
      const validated = validateDesignDocument(parsed.data.document);
      if (!validated.ok) {
        return Response.json({ error: validated.error }, { status: 400 });
      }
    }

    const updated = await prisma.design.update({
      where: { id: existing.id },
      data: {
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.document !== undefined
          ? { document: parsed.data.document as unknown as Prisma.InputJsonValue }
          : {}),
        ...(parsed.data.thumbnail !== undefined ? { thumbnail: parsed.data.thumbnail } : {}),
      },
    });
    return Response.json({ design: fullDesign(updated) });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const { id } = await ctx.params;
    const existing = await prisma.design.findFirst({
      where: { id, workspaceId: workspace.id },
    });
    if (!existing) return Response.json({ error: "Design not found" }, { status: 404 });
    await prisma.design.delete({ where: { id: existing.id } });
    return Response.json({ ok: true });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
