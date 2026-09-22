// Marketr — content autopilot API: rules (milestone 18).
// GET /api/autopilot/rules?projectId=   → rule list
// POST /api/autopilot/rules            { projectId, ...ruleInput }

import { accessibleWorkspaceWhere, forbidden, requireProjectRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { createAutopilotRule } from "@/lib/seo/autopilot-service";
import type { NextRequest } from "next/server";

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

  const [rules, kill] = await Promise.all([
    prisma.autopilotRule.findMany({
      where: { projectId: project.id },
      orderBy: { updatedAt: "desc" },
      include: { _count: { select: { items: true } } },
    }),
    prisma.autopilotKillSwitch.findMany({
      where: {
        scopeKey: { in: [`workspace:${project.workspaceId}`, `project:${project.id}`] },
      },
    }),
  ]);
  return Response.json({ rules, kill });
}

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const project = await ownedProject(user.id, body.projectId);
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  if (!(await requireProjectRole(user.id, project.id, "editor"))) return forbidden();

  try {
    const { id } = await createAutopilotRule(prisma, {
      workspaceId: project.workspaceId,
      projectId: project.id,
      input: body,
    });
    return Response.json({ id }, { status: 201 });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed to create rule" }, { status: 400 });
  }
}
