// Marketr — ad factory API: regenerate a creative with an edited prompt.
// POST /api/ads/creatives/[id]/regenerate { projectId, prompt? }
// Explicit user action only — there is no automatic regeneration anywhere.

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { regenerateCreative } from "@/lib/ads/service";
import { ownedProject, readJson, requireEditor, workspacePort } from "../../../_lib";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const body = await readJson(req);
  const project = await ownedProject(user.id, body.projectId);
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  const creative = await prisma.adCreative.findFirst({ where: { id, projectId: project.id } });
  if (!creative) return Response.json({ error: "Creative not found" }, { status: 404 });
  const denied = await requireEditor(user.id, project.id);
  if (denied) return denied;
  const ported = await workspacePort(project.workspaceId);
  if ("response" in ported) return ported.response;
  try {
    const updated = await regenerateCreative(
      prisma,
      project.workspaceId,
      id,
      { prompt: typeof body.prompt === "string" ? body.prompt : undefined, port: ported.port },
      "user",
    );
    return Response.json({ creative: updated });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Regeneration failed." }, { status: 400 });
  }
}
