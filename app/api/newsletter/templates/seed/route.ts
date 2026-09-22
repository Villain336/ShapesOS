// Marketr — newsletter API: seed starter templates (milestone 19).
// POST /api/newsletter/templates/seed { projectId }

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { seedStarterTemplates } from "@/lib/newsletter/service";
import { ownedProject, requireEditor, readJson } from "../../_lib";

export async function POST(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const body = await readJson(req);
  const project = await ownedProject(user.id, body.projectId);
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  const denied = await requireEditor(user.id, project.id);
  if (denied) return denied;
  const seeded = await seedStarterTemplates(prisma, project.id, project.workspaceId);
  return Response.json({ seeded });
}
