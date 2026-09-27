// Marketr — studio designs: share links (Feature 6).
// GET  /api/studio/designs/[id]/shares — list active shares for the design
// POST /api/studio/designs/[id]/shares — create a share link (returns the raw
//   token ONCE; only its SHA-256 is stored). Optional { expiresInDays }.

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { guardWorkspace, httpErrorResponse, readJson } from "../../_lib";
import { HttpError } from "@/lib/enrichment/guard";
import { hashShareToken, newShareToken, shareUrl } from "@/lib/design/sharing";

export const dynamic = "force-dynamic";

const CreateSchema = z.object({
  expiresInDays: z.number().int().min(1).max(365).optional(),
});

async function getDesign(id: string, workspaceId: string) {
  const design = await prisma.design.findFirst({
    where: { id, workspaceId },
    select: { id: true },
  });
  if (!design) throw new HttpError(404, "Design not found");
  return design;
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const { workspace } = await guardWorkspace();
    await getDesign(id, workspace.id);
    const shares = await prisma.designShare.findMany({
      where: { designId: id, workspaceId: workspace.id },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        createdAt: true,
        expiresAt: true,
        revokedAt: true,
      },
    });
    return Response.json({
      shares: shares.map((s) => ({
        id: s.id,
        createdAt: s.createdAt.toISOString(),
        expiresAt: s.expiresAt?.toISOString() ?? null,
        revokedAt: s.revokedAt?.toISOString() ?? null,
        active: !s.revokedAt && (!s.expiresAt || s.expiresAt > new Date()),
      })),
    });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
    const { id } = await ctx.params;
  try {
    const { user, workspace } = await guardWorkspace({ editor: true });
    await getDesign(id, workspace.id);
    let raw: unknown = {};
    try {
      raw = await readJson(req);
    } catch {
      raw = {};
    }
    const parsed = CreateSchema.safeParse(raw);
    if (!parsed.success) {
      return Response.json(
        { error: "Invalid input", issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const token = newShareToken();
    const share = await prisma.designShare.create({
      data: {
        designId: id,
        workspaceId: workspace.id,
        tokenHash: hashShareToken(token),
        createdBy: user.id,
        expiresAt: parsed.data.expiresInDays
          ? new Date(Date.now() + parsed.data.expiresInDays * 86400_000)
          : null,
      },
      select: { id: true, createdAt: true, expiresAt: true },
    });
    return Response.json(
      {
        share: {
          id: share.id,
          createdAt: share.createdAt.toISOString(),
          expiresAt: share.expiresAt?.toISOString() ?? null,
        },
        // Raw token — shown ONCE. It is never stored or retrievable again.
        token,
        url: shareUrl(new URL(req.url).origin, token),
      },
      { status: 201 },
    );
  } catch (e) {
    return httpErrorResponse(e);
  }
}
