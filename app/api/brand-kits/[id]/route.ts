// Marketr — single brand kit API (milestone 12).
// GET /api/brand-kits/[id] · PATCH (editor+) · DELETE (editor+)

import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import type { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";

async function owned(userId: string, email: string | null | undefined, id: string) {
  const workspace = await getOrCreateWorkspace(userId, email);
  const brandKit = await prisma.brandKit.findFirst({ where: { id, workspaceId: workspace.id } });
  return { workspace, brandKit };
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const { brandKit } = await owned(user.id, user.email, id);
  if (!brandKit) return Response.json({ error: "Brand kit not found" }, { status: 404 });
  return Response.json({ brandKit });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const { workspace, brandKit } = await owned(user.id, user.email, id);
  if (!brandKit) return Response.json({ error: "Brand kit not found" }, { status: 404 });
  if (!(await requireWorkspaceRole(user.id, workspace.id, "editor"))) return forbidden();

  let body: {
    name?: string;
    colors?: Record<string, string>;
    fonts?: Record<string, string>;
    tone?: string | null;
    clientId?: string | null;
    isDefault?: boolean;
    /* PROVIDER:brandfetch */
    // Typed as InputJsonValue: req.json() can only ever produce JSON values.
    metadata?: Prisma.InputJsonValue | null;
    /* END */
  };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const updated = await prisma.$transaction(async (tx) => {
    if (body.isDefault) {
      await tx.brandKit.updateMany({ where: { workspaceId: workspace.id }, data: { isDefault: false } });
    }
    return tx.brandKit.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name.trim().slice(0, 120) } : {}),
        ...(body.colors !== undefined ? { colors: body.colors } : {}),
        ...(body.fonts !== undefined ? { fonts: body.fonts } : {}),
        ...(body.tone !== undefined ? { tone: body.tone?.slice(0, 2000) || null } : {}),
        ...(body.clientId !== undefined ? { clientId: body.clientId || null } : {}),
        ...(body.isDefault !== undefined ? { isDefault: Boolean(body.isDefault) } : {}),
        /* PROVIDER:brandfetch */
        ...(body.metadata !== undefined ? { metadata: body.metadata ?? {} } : {}),
        /* END */
      },
    });
  });
  return Response.json({ brandKit: updated });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const { workspace, brandKit } = await owned(user.id, user.email, id);
  if (!brandKit) return Response.json({ error: "Brand kit not found" }, { status: 404 });
  if (!(await requireWorkspaceRole(user.id, workspace.id, "editor"))) return forbidden();

  await prisma.brandKit.delete({ where: { id } });
  return Response.json({ ok: true });
}
