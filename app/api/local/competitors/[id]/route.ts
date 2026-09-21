// Marketr — single local competitor API (milestone 16).
// GET    /api/local/competitors/[id] → competitor + snapshot history (viewer+).
// PATCH  /api/local/competitors/[id] { businessName?, placeId?, domain?, lat?, lng?, enabled? } (editor+).
// DELETE /api/local/competitors/[id] (editor+).

import { accessibleWorkspaceWhere, requireProjectRole, forbidden } from "@/lib/authz";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";

async function ownedCompetitor(userId: string, id: string) {
  return prisma.localCompetitor.findFirst({
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
  const competitor = await ownedCompetitor(user.id, id);
  if (!competitor) return Response.json({ error: "Competitor not found" }, { status: 404 });
  if (!(await requireProjectRole(user.id, competitor.project.id, "viewer"))) return forbidden();

  const snapshots = await prisma.localCompetitorSnapshot.findMany({
    where: { localCompetitorId: competitor.id },
    orderBy: { date: "desc" },
    take: 30,
  });
  const { project: _p, ...rest } = competitor;
  return Response.json({ competitor: rest, snapshots });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const competitor = await ownedCompetitor(user.id, id);
  if (!competitor) return Response.json({ error: "Competitor not found" }, { status: 404 });
  if (!(await requireProjectRole(user.id, competitor.project.id, "editor"))) return forbidden();

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const data: Record<string, unknown> = {};
  if (typeof body.businessName === "string" && body.businessName.trim())
    data.businessName = body.businessName.trim().slice(0, 200);
  if (body.placeId !== undefined)
    data.placeId = typeof body.placeId === "string" && body.placeId.trim() ? body.placeId.trim().slice(0, 200) : null;
  if (body.domain !== undefined)
    data.domain =
      typeof body.domain === "string" && body.domain.trim()
        ? body.domain.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0].slice(0, 200)
        : null;
  if (body.lat !== undefined || body.lng !== undefined) {
    const la = Number(body.lat ?? competitor.lat);
    const ln = Number(body.lng ?? competitor.lng);
    if (!Number.isFinite(la) || la < -90 || la > 90 || !Number.isFinite(ln) || ln < -180 || ln > 180) {
      return Response.json({ error: "lat/lng out of range" }, { status: 400 });
    }
    data.lat = la;
    data.lng = ln;
  }
  if (typeof body.enabled === "boolean") data.enabled = body.enabled;

  const updated = await prisma.localCompetitor.update({ where: { id: competitor.id }, data });
  return Response.json({ competitor: updated });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const competitor = await ownedCompetitor(user.id, id);
  if (!competitor) return Response.json({ error: "Competitor not found" }, { status: 404 });
  if (!(await requireProjectRole(user.id, competitor.project.id, "editor"))) return forbidden();

  await prisma.localCompetitor.delete({ where: { id: competitor.id } });
  return Response.json({ ok: true });
}
