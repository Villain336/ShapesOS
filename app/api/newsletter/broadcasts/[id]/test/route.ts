// Marketr — newsletter API: test send (milestone 19).
// POST /api/newsletter/broadcasts/[id]/test { projectId, to }
// A completed test send is a server-side guardrail for every broadcast.

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { testSend } from "@/lib/newsletter/service";
import { ownedProject, requireEditor, readJson, workspacePort } from "../../../_lib";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const body = await readJson(req);
  const project = await ownedProject(user.id, body.projectId);
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  const denied = await requireEditor(user.id, project.id);
  if (denied) return denied;
  const portResult = await workspacePort(project.workspaceId);
  if ("response" in portResult) return portResult.response;
  try {
    await testSend(prisma, id, project.workspaceId, project.id, String(body.to ?? ""), portResult.port);
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Test send failed." }, { status: 400 });
  }
}
