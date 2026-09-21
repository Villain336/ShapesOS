// Marketr — competitor radar feed API (milestone 14).
// GET  /api/radar?projectId=…[&unread=1][&competitor=…] → events (viewer+).
// POST /api/radar { eventIds: string[], action: "mark_read" } (editor+).

import { accessibleWorkspaceWhere, requireProjectRole, forbidden } from "@/lib/authz";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";

async function ownedProject(userId: string, projectId: unknown) {
  if (typeof projectId !== "string" || !projectId) return null;
  return prisma.project.findFirst({
    where: { id: projectId, workspace: accessibleWorkspaceWhere(userId) },
    select: { id: true },
  });
}

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const project = await ownedProject(user.id, req.nextUrl.searchParams.get("projectId"));
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  if (!(await requireProjectRole(user.id, project.id, "viewer"))) return forbidden();

  const competitor = req.nextUrl.searchParams.get("competitor");
  const unreadOnly = req.nextUrl.searchParams.get("unread") === "1";

  const events = await prisma.competitorRadarEvent.findMany({
    where: {
      projectId: project.id,
      ...(competitor ? { competitorDomain: competitor } : {}),
      ...(unreadOnly ? { read: false } : {}),
    },
    orderBy: { detectedAt: "desc" },
    take: 200,
  });

  const competitors = await prisma.competitor.findMany({
    where: { projectId: project.id },
    orderBy: { domain: "asc" },
    select: { domain: true },
  });

  return Response.json({ events, competitors: competitors.map((c) => c.domain) });
}

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  let body: { projectId?: string; eventIds?: string[]; action?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const project = await ownedProject(user.id, body.projectId);
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  if (!(await requireProjectRole(user.id, project.id, "editor"))) return forbidden();
  if (body.action !== "mark_read" || !Array.isArray(body.eventIds) || body.eventIds.length === 0) {
    return Response.json({ error: "Invalid action" }, { status: 400 });
  }

  await prisma.competitorRadarEvent.updateMany({
    where: { id: { in: body.eventIds }, projectId: project.id },
    data: { read: true },
  });
  return Response.json({ ok: true });
}
