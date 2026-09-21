// Marketr — single geo-grid API (milestone 16).
// GET    /api/local/grids/[id] → grid + result history (viewer+).
// PATCH  /api/local/grids/[id] { name?, keyword?, businessName?, centerLat?, centerLng?,
//                                radiusMiles?, gridSize?, schedule?, enabled? } (editor+).
// DELETE /api/local/grids/[id] (editor+).

import { accessibleWorkspaceWhere, requireProjectRole, forbidden } from "@/lib/authz";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { clampGridSize } from "@/lib/local/grid";

export const dynamic = "force-dynamic";

async function ownedGrid(userId: string, id: string) {
  return prisma.localGrid.findFirst({
    where: { id, project: { workspace: accessibleWorkspaceWhere(userId) } },
    include: { project: { select: { id: true } } },
  });
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const grid = await ownedGrid(user.id, id);
  if (!grid) return Response.json({ error: "Grid not found" }, { status: 404 });
  if (!(await requireProjectRole(user.id, grid.project.id, "viewer"))) return forbidden();

  const results = await prisma.localGridResult.findMany({
    where: { localGridId: grid.id },
    orderBy: { runAt: "desc" },
    take: 20,
  });
  const { project: _p, ...rest } = grid;
  return Response.json({ grid: rest, results });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const grid = await ownedGrid(user.id, id);
  if (!grid) return Response.json({ error: "Grid not found" }, { status: 404 });
  if (!(await requireProjectRole(user.id, grid.project.id, "editor"))) return forbidden();

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const data: Record<string, unknown> = {};
  if (typeof body.name === "string" && body.name.trim()) data.name = body.name.trim().slice(0, 80);
  if (typeof body.keyword === "string" && body.keyword.trim()) data.keyword = body.keyword.trim().slice(0, 200);
  if (typeof body.businessName === "string" && body.businessName.trim())
    data.businessName = body.businessName.trim().slice(0, 200);
  if (body.centerLat !== undefined) {
    const v = Number(body.centerLat);
    if (!Number.isFinite(v) || v < -90 || v > 90)
      return Response.json({ error: "centerLat must be between -90 and 90" }, { status: 400 });
    data.centerLat = v;
  }
  if (body.centerLng !== undefined) {
    const v = Number(body.centerLng);
    if (!Number.isFinite(v) || v < -180 || v > 180)
      return Response.json({ error: "centerLng must be between -180 and 180" }, { status: 400 });
    data.centerLng = v;
  }
  if (body.radiusMiles !== undefined) {
    const v = Number(body.radiusMiles);
    if (!Number.isFinite(v)) return Response.json({ error: "radiusMiles must be a number" }, { status: 400 });
    data.radiusMiles = Math.max(0.1, Math.min(100, v));
  }
  if (body.gridSize !== undefined) data.gridSize = clampGridSize(Number(body.gridSize));
  if (body.schedule === "manual" || body.schedule === "weekly") data.schedule = body.schedule;
  if (typeof body.enabled === "boolean") data.enabled = body.enabled;

  const updated = await prisma.localGrid.update({ where: { id: grid.id }, data });
  return Response.json({ grid: updated });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const grid = await ownedGrid(user.id, id);
  if (!grid) return Response.json({ error: "Grid not found" }, { status: 404 });
  if (!(await requireProjectRole(user.id, grid.project.id, "editor"))) return forbidden();

  await prisma.localGrid.delete({ where: { id: grid.id } });
  return Response.json({ ok: true });
}
