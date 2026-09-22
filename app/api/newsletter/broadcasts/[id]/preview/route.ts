// Marketr — newsletter API: broadcast preview + test send + send (milestone 19).
// GET  /api/newsletter/broadcasts/[id]/preview?projectId= → rendered HTML
// POST /api/newsletter/broadcasts/[id]/test { projectId, to } → test send (required before send)
// POST /api/newsletter/broadcasts/[id]/send { projectId } → guardrailed send

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { renderBroadcast, sendBroadcast, testSend } from "@/lib/newsletter/service";
import { ownedProject, requireEditor, readJson, workspacePort } from "../../../_lib";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const project = await ownedProject(user.id, new URL(req.url).searchParams.get("projectId"));
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  const b = await prisma.newsletterBroadcast.findFirst({ where: { id, projectId: project.id } });
  if (!b) return Response.json({ error: "Broadcast not found" }, { status: 404 });
  const { html } = await renderBroadcast(prisma, id, project.workspaceId, { unsubscribeToken: "preview" });
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}
