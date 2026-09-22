// Marketr — content autopilot API: runs (milestone 18).
// GET /api/autopilot/runs?projectId=   → recent runs
// POST /api/autopilot/runs            { projectId, ruleId }  (editor+; kill switch enforced)

import { accessibleWorkspaceWhere, forbidden, requireProjectRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { runAutopilotRule } from "@/lib/seo/autopilot-service";

async function ownedProject(userId: string, projectId: unknown) {
  if (typeof projectId !== "string" || !projectId) return null;
  return prisma.project.findFirst({
    where: { id: projectId, workspace: accessibleWorkspaceWhere(userId) },
    select: { id: true, workspaceId: true },
  });
}

export async function GET(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const project = await ownedProject(user.id, new URL(req.url).searchParams.get("projectId"));
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });

  const runs = await prisma.autopilotRun.findMany({
    where: { projectId: project.id },
    orderBy: { startedAt: "desc" },
    take: 25,
    include: { rule: { select: { id: true, name: true } } },
  });
  return Response.json({ runs });
}

export async function POST(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  let body: { projectId?: string; ruleId?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const project = await ownedProject(user.id, body.projectId);
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  if (!(await requireProjectRole(user.id, project.id, "editor"))) return forbidden();
  if (!body.ruleId) return Response.json({ error: "ruleId is required" }, { status: 400 });

  try {
    const result = await runAutopilotRule(prisma, {
      workspaceId: project.workspaceId,
      projectId: project.id,
      ruleId: body.ruleId,
      actor: user.id,
    });
    return Response.json(result, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Run failed";
    const status = /killed/i.test(msg) ? 423 : /disabled|not found/i.test(msg) ? 400 : 502;
    return Response.json({ error: msg }, { status });
  }
}
