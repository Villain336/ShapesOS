// Marketr — competitor management API (spec §5 flow 2, §7 item 4).
// GET  /api/competitors?projectId=…        → { competitors }
// POST /api/competitors  { projectId, domain } → { competitor } (201)
// Domains are normalized (strip protocol/www/path) and deduped per project.

import { accessibleWorkspaceWhere, requireProjectRole, forbidden } from "@/lib/authz";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { normalizeDomain } from "@/lib/competitors";

async function ownedProject(userId: string, projectId: unknown) {
  if (typeof projectId !== "string" || !projectId) return null;
  return prisma.project.findFirst({
    where: { id: projectId, workspace: accessibleWorkspaceWhere(userId) },
  });
}

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const projectId = req.nextUrl.searchParams.get("projectId");
  const project = await ownedProject(user.id, projectId);
  if (!project) {
    return Response.json({ error: "Project not found" }, { status: 404 });
  }

  const competitors = await prisma.competitor.findMany({
    where: { projectId: project.id },
    orderBy: { addedAt: "asc" },
  });
  return Response.json({ competitors });
}

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  let body: { projectId?: string; domain?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const project = await ownedProject(user.id, body.projectId);
  if (!project) {
    return Response.json({ error: "Project not found" }, { status: 404 });
  }
  if (!(await requireProjectRole(user.id, body.projectId, "editor"))) return forbidden();

  const domain = normalizeDomain(body.domain);
  if (!domain) {
    return Response.json(
      { error: "Enter a valid domain, e.g. example.com" },
      { status: 400 },
    );
  }

  const competitor = await prisma.competitor.upsert({
    where: { projectId_domain: { projectId: project.id, domain } },
    update: {},
    create: { projectId: project.id, domain },
  });

  return Response.json({ competitor }, { status: 201 });
}
