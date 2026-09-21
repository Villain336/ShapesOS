// Marketr — project CRUD (milestone 2: basic, functional).
// GET  /api/projects        → workspace + its projects
// POST /api/projects        → create project { domain, locale? }

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { requireWorkspaceRole, forbidden } from "@/lib/authz";

export async function GET() {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const projects = await prisma.project.findMany({
    where: { workspaceId: workspace.id },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { keywords: true } } },
  });

  return Response.json({
    workspace: { id: workspace.id, name: workspace.name, plan: workspace.plan },
    projects,
  });
}

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  let body: { domain?: string; locale?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const domain = String(body.domain ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .split("/")[0];
  if (!domain) {
    return Response.json({ error: "domain is required" }, { status: 400 });
  }

  const workspace = await getOrCreateWorkspace(user.id, user.email);
  // Milestone 11: project creation is editor+ (viewers are read-only).
  if (!(await requireWorkspaceRole(user.id, workspace.id, "editor"))) return forbidden();
  const project = await prisma.project.create({
    data: {
      workspaceId: workspace.id,
      domain,
      locale: body.locale?.trim() || "en-US",
    },
  });

  return Response.json({ project }, { status: 201 });
}
