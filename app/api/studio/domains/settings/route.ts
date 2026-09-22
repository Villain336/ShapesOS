// Marketr — studio API: Porkbun API keys (milestone 22).
// GET    /api/studio/domains/settings?projectId= → { configured, hint }
// POST   /api/studio/domains/settings { projectId, apiKey, secretApiKey } (owner/admin)
// DELETE /api/studio/domains/settings { projectId } (owner/admin)

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { removePorkbunKeys, savePorkbunKeys } from "@/lib/studio/service";
import { ownedProject, readJson, requireOwnerAdmin } from "../../_lib";

export async function GET(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const project = await ownedProject(user.id, new URL(req.url).searchParams.get("projectId"));
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  const row = await prisma.studioPorkbunSettings.findUnique({ where: { workspaceId: project.workspaceId } });
  return Response.json({ configured: !!row, hint: row?.apiKeyHint ?? null });
}

export async function POST(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const body = await readJson(req);
  const project = await ownedProject(user.id, body.projectId);
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  const denied = await requireOwnerAdmin(user.id, project.id);
  if (denied) return denied;
  try {
    const { hint } = await savePorkbunKeys(
      prisma,
      project.workspaceId,
      { apiKey: String(body.apiKey ?? ""), secretApiKey: String(body.secretApiKey ?? "") },
      "user",
    );
    return Response.json({ configured: true, hint });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to save keys." },
      { status: 400 },
    );
  }
}

export async function DELETE(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const body = await readJson(req);
  const project = await ownedProject(user.id, body.projectId);
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  const denied = await requireOwnerAdmin(user.id, project.id);
  if (denied) return denied;
  await removePorkbunKeys(prisma, project.workspaceId);
  return Response.json({ ok: true });
}
