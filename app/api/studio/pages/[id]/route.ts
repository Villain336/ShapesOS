// Marketr — studio pages API (Phase 12, GrapesJS page drafts).
// GET    /api/studio/pages/[id] — full draft (html/css/components)
// PATCH  /api/studio/pages/[id] — save draft { name?, html?, css?, components? }
// DELETE /api/studio/pages/[id] — delete draft

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { guardWorkspace, httpErrorResponse, readJson } from "../../designs/_lib";

export const dynamic = "force-dynamic";

const SaveSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  html: z.string().max(2_000_000).optional(),
  css: z.string().max(500_000).optional(),
  // GrapesJS project data (JSON) — persisted as-is, reloaded verbatim.
  components: z.unknown().optional(),
});

async function ownedPage(workspaceId: string, id: string) {
  return prisma.pageDraft.findFirst({ where: { id, workspaceId } });
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { workspace } = await guardWorkspace();
    const { id } = await params;
    const page = await ownedPage(workspace.id, id);
    if (!page) return NextResponse.json({ error: "Page not found." }, { status: 404 });
    return NextResponse.json({
      page: {
        id: page.id,
        name: page.name,
        kind: page.kind,
        templateKey: page.templateKey,
        html: page.html,
        css: page.css,
        components: page.components,
        updatedAt: page.updatedAt.toISOString(),
      },
    });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const { id } = await params;
    const page = await ownedPage(workspace.id, id);
    if (!page) return NextResponse.json({ error: "Page not found." }, { status: 404 });
    const body = SaveSchema.parse(await readJson(req));
    const updated = await prisma.pageDraft.update({
      where: { id: page.id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.html !== undefined ? { html: body.html } : {}),
        ...(body.css !== undefined ? { css: body.css } : {}),
        ...(body.components !== undefined ? { components: body.components ?? undefined } : {}),
      },
    });
    return NextResponse.json({ page: { id: updated.id, updatedAt: updated.updatedAt.toISOString() } });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const { id } = await params;
    const page = await ownedPage(workspace.id, id);
    if (!page) return NextResponse.json({ error: "Page not found." }, { status: 404 });
    await prisma.pageDraft.delete({ where: { id: page.id } });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
