// Marketr — studio creative detail API (Phase 4, T2).
// GET    /api/studio/creatives/[id]
// PATCH  /api/studio/creatives/[id] { name? } (editor)
// DELETE /api/studio/creatives/[id] -> archive (editor)

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { archiveCreative, getCreative } from "@/lib/studio/creatives";
import {
  creativeErrorResponse,
  guardWorkspace,
  readJson,
} from "../_lib";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  try {
    const { workspace } = await guardWorkspace();
    const { id } = await params;
    const creative = await getCreative(prisma, workspace.id, id);
    if (!creative) return Response.json({ error: "Creative not found." }, { status: 404 });
    return Response.json({ creative });
  } catch (e) {
    return creativeErrorResponse(e);
  }
}

const PatchSchema = z.object({ name: z.string().trim().min(1).max(120) });

export async function PATCH(req: Request, { params }: Params) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const { id } = await params;
    const parsed = PatchSchema.safeParse(await readJson(req));
    if (!parsed.success) {
      return Response.json({ error: "Invalid input", issues: parsed.error.issues }, { status: 400 });
    }
    const row = await prisma.mailCreative.findFirst({ where: { id, workspaceId: workspace.id } });
    if (!row) return Response.json({ error: "Creative not found." }, { status: 404 });
    const updated = await prisma.mailCreative.update({
      where: { id: row.id },
      data: { name: parsed.data.name },
    });
    return Response.json({
      creative: {
        ...updated,
        createdAt: updated.createdAt.toISOString(),
        updatedAt: updated.updatedAt.toISOString(),
      },
    });
  } catch (e) {
    return creativeErrorResponse(e);
  }
}

export async function DELETE(_req: Request, { params }: Params) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const { id } = await params;
    const creative = await archiveCreative(prisma, workspace.id, id);
    return Response.json({ creative });
  } catch (e) {
    return creativeErrorResponse(e);
  }
}
