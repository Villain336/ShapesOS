// Marketr — local SEO geo-grids API (milestone 16).
// GET  /api/local/grids?projectId=… → grids with latest result summary (viewer+).
// POST /api/local/grids { projectId, name, keyword, businessName, centerLat, centerLng,
//                         radiusMiles?, gridSize?, schedule? } → create (editor+).

import { accessibleWorkspaceWhere, requireProjectRole, forbidden } from "@/lib/authz";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { clampGridSize } from "@/lib/local/grid";

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

  const grids = await prisma.localGrid.findMany({
    where: { projectId: project.id },
    orderBy: { createdAt: "desc" },
    include: {
      results: { orderBy: { runAt: "desc" }, take: 1 },
      _count: { select: { results: true } },
    },
  });
  return Response.json({
    grids: grids.map((g) => ({
      id: g.id,
      name: g.name,
      keyword: g.keyword,
      businessName: g.businessName,
      centerLat: g.centerLat,
      centerLng: g.centerLng,
      radiusMiles: g.radiusMiles,
      gridSize: g.gridSize,
      schedule: g.schedule,
      enabled: g.enabled,
      lastRunAt: g.lastRunAt,
      runCount: g._count.results,
      latest: g.results[0]
        ? {
            runAt: g.results[0].runAt,
            coveragePct: g.results[0].coveragePct,
            avgPosition: g.results[0].avgPosition,
            cells: (g.results[0].cells as unknown[]).length,
            mock: g.results[0].mock,
          }
        : null,
    })),
  });
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

  const project = await ownedProject(user.id, body.projectId);
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  if (!(await requireProjectRole(user.id, project.id, "editor"))) return forbidden();

  const name = typeof body.name === "string" ? body.name.trim().slice(0, 80) : "";
  const keyword = typeof body.keyword === "string" ? body.keyword.trim().slice(0, 200) : "";
  const businessName = typeof body.businessName === "string" ? body.businessName.trim().slice(0, 200) : "";
  const centerLat = Number(body.centerLat);
  const centerLng = Number(body.centerLng);
  if (!name || !keyword || !businessName) {
    return Response.json({ error: "name, keyword, and businessName are required" }, { status: 400 });
  }
  if (!Number.isFinite(centerLat) || centerLat < -90 || centerLat > 90) {
    return Response.json({ error: "centerLat must be between -90 and 90" }, { status: 400 });
  }
  if (!Number.isFinite(centerLng) || centerLng < -180 || centerLng > 180) {
    return Response.json({ error: "centerLng must be between -180 and 180" }, { status: 400 });
  }
  const radiusMiles =
    body.radiusMiles === undefined ? 5 : Math.max(0.1, Math.min(100, Number(body.radiusMiles)));
  if (!Number.isFinite(radiusMiles)) {
    return Response.json({ error: "radiusMiles must be a number" }, { status: 400 });
  }
  const gridSize = clampGridSize(Number(body.gridSize ?? 5));
  const schedule = body.schedule === "manual" ? "manual" : "weekly";

  const grid = await prisma.localGrid.create({
    data: {
      projectId: project.id,
      name,
      keyword,
      businessName,
      centerLat,
      centerLng,
      radiusMiles,
      gridSize,
      schedule,
    },
  });
  return Response.json({ grid }, { status: 201 });
}
