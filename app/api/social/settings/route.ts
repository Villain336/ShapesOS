// Marketr — social API: Buffer connection settings (milestone 20).
// GET /api/social/settings?projectId= → { connected, hint }
// POST /api/social/settings { projectId, token } → store encrypted token
// DELETE /api/social/settings?projectId= → revoke token

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { getSocialSettings, revokeBufferToken, setBufferToken } from "@/lib/social/service";
import { ownedProject, readJson, requireWorkspaceEditor } from "../_lib";

export async function GET(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const project = await ownedProject(user.id, new URL(req.url).searchParams.get("projectId"));
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  const settings = await getSocialSettings(prisma, project.workspaceId);
  return Response.json({
    connected: !!settings?.bufferTokenEnc,
    hint: settings?.bufferTokenHint ?? null,
    updatedAt: settings?.updatedAt?.toISOString() ?? null,
  });
}

export async function POST(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const body = await readJson(req);
  const project = await ownedProject(user.id, body.projectId);
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  const denied = await requireWorkspaceEditor(user.id, project.workspaceId);
  if (denied) return denied;
  const token = typeof body.token === "string" ? body.token : "";
  if (!token.trim()) return Response.json({ error: "Buffer access token is required." }, { status: 400 });
  try {
    const { hint } = await setBufferToken(prisma, project.workspaceId, token, "user");
    return Response.json({ connected: true, hint });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed to save token." }, { status: 400 });
  }
}

export async function DELETE(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const project = await ownedProject(user.id, new URL(req.url).searchParams.get("projectId"));
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  const denied = await requireWorkspaceEditor(user.id, project.workspaceId);
  if (denied) return denied;
  await revokeBufferToken(prisma, project.workspaceId, "user");
  return Response.json({ connected: false });
}
