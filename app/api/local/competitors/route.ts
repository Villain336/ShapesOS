// Marketr — local competitors API (milestone 16).
// GET  /api/local/competitors?projectId=… → competitors with latest snapshot (viewer+).
// POST /api/local/competitors { projectId, businessName, placeId?, domain?, lat?, lng? } (editor+).
// POST /api/local/competitors/refresh { projectId } → run the refresh now (editor+).

import { accessibleWorkspaceWhere, requireProjectRole, forbidden } from "@/lib/authz";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { refreshLocalCompetitors } from "@/lib/local/service";

export const dynamic = "force-dynamic";

async function ownedProject(userId: string, projectId: unknown) {
  if (typeof projectId !== "string" || !projectId) return null;
  return prisma.project.findFirst({
    where: { id: projectId, workspace: accessibleWorkspaceWhere(userId) },
    select: { id: true, workspaceId: true },
  });
}

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const project = await ownedProject(user.id, req.nextUrl.searchParams.get("projectId"));
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  if (!(await requireProjectRole(user.id, project.id, "viewer"))) return forbidden();

  const competitors = await prisma.localCompetitor.findMany({
    where: { projectId: project.id },
    orderBy: { createdAt: "desc" },
    include: { snapshots: { orderBy: { date: "desc" }, take: 2 } },
  });
  return Response.json({ competitors });
}

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Refresh action: POST /api/local/competitors { projectId, action: "refresh" }.
  if (body.action === "refresh") {
    const project = await ownedProject(user.id, body.projectId);
    if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
    if (!(await requireProjectRole(user.id, project.id, "editor"))) return forbidden();
    const result = await refreshLocalCompetitors(project.id, `user:${user.id}`);
    if ("error" in result) return Response.json({ error: result.error }, { status: 400 });
    return Response.json({ result });
  }

  const project = await ownedProject(user.id, body.projectId);
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  if (!(await requireProjectRole(user.id, project.id, "editor"))) return forbidden();

  const businessName = typeof body.businessName === "string" ? body.businessName.trim().slice(0, 200) : "";
  if (!businessName) return Response.json({ error: "businessName is required" }, { status: 400 });

  // Default the search center to the project's first grid center so the
  // competitor is looked up in the same market.
  let lat: number | null = null;
  let lng: number | null = null;
  if (body.lat !== undefined && body.lng !== undefined) {
    const la = Number(body.lat);
    const ln = Number(body.lng);
    if (Number.isFinite(la) && la >= -90 && la <= 90 && Number.isFinite(ln) && ln >= -180 && ln <= 180) {
      lat = la;
      lng = ln;
    }
  }
  if (lat == null || lng == null) {
    const grid = await prisma.localGrid.findFirst({
      where: { projectId: project.id, enabled: true },
      orderBy: { createdAt: "asc" },
      select: { centerLat: true, centerLng: true },
    });
    if (grid) {
      lat = grid.centerLat;
      lng = grid.centerLng;
    }
  }

  const competitor = await prisma.localCompetitor.create({
    data: {
      projectId: project.id,
      businessName,
      placeId: typeof body.placeId === "string" && body.placeId.trim() ? body.placeId.trim().slice(0, 200) : null,
      domain:
        typeof body.domain === "string" && body.domain.trim()
          ? body.domain.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0].slice(0, 200)
          : null,
      lat,
      lng,
    },
  });
  return Response.json({ competitor }, { status: 201 });
}
