// Marketr — brand kit CRUD API (milestone 12, white-label reporting).
// GET  /api/brand-kits              → { brandKits }
// POST /api/brand-kits              { name, colors?, fonts?, tone?, clientId? } → { brandKit } (201)
// Reads: any workspace member. Writes: editor+.

import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";

async function workspaceOf(userId: string, email?: string | null) {
  return getOrCreateWorkspace(userId, email);
}

export async function GET() {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await workspaceOf(user.id, user.email);

  const brandKits = await prisma.brandKit.findMany({
    where: { workspaceId: workspace.id },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    include: { _count: { select: { templates: true, reports: true } } },
  });
  return Response.json({ brandKits });
}

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await workspaceOf(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "editor"))) return forbidden();

  let body: {
    name?: string;
    colors?: Record<string, string>;
    fonts?: Record<string, string>;
    tone?: string;
    clientId?: string;
    isDefault?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.name?.trim()) {
    return Response.json({ error: "Name is required" }, { status: 400 });
  }

  const data = {
    workspaceId: workspace.id,
    name: body.name.trim().slice(0, 120),
    colors: body.colors ?? {},
    fonts: body.fonts ?? {},
    tone: body.tone?.slice(0, 2000) || null,
    clientId: body.clientId || null,
    isDefault: Boolean(body.isDefault),
  };

  const brandKit = await prisma.$transaction(async (tx) => {
    if (data.isDefault) {
      await tx.brandKit.updateMany({ where: { workspaceId: workspace.id }, data: { isDefault: false } });
    }
    return tx.brandKit.create({ data });
  });
  return Response.json({ brandKit }, { status: 201 });
}
