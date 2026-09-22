// Marketr — ad factory API: workspace settings (milestone 21).
// GET /api/ads/settings?projectId= → { connected, hint, capCents, spend summary }
// POST /api/ads/settings { projectId, key } → store encrypted Higgsfield key
// PATCH /api/ads/settings { projectId, monthlyCapCents } → update spend cap
// DELETE /api/ads/settings?projectId= → revoke key

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import {
  getAdSettings,
  getSpendSummary,
  revokeHiggsfieldKey,
  setHiggsfieldKey,
  updateSpendCap,
} from "@/lib/ads/service";
import { ownedProject, readJson, requireWorkspaceEditor } from "../_lib";

export async function GET(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const project = await ownedProject(user.id, new URL(req.url).searchParams.get("projectId"));
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  const [settings, spend] = await Promise.all([
    getAdSettings(prisma, project.workspaceId),
    getSpendSummary(prisma, project.workspaceId),
  ]);
  return Response.json({
    connected: !!settings?.higgsfieldKeyEnc,
    hint: settings?.higgsfieldKeyHint ?? null,
    capCents: settings?.monthlyCapCents ?? 5000,
    spend,
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
  const key = typeof body.key === "string" ? body.key : "";
  if (!key.trim()) return Response.json({ error: "Higgsfield API key is required." }, { status: 400 });
  try {
    const { hint } = await setHiggsfieldKey(prisma, project.workspaceId, key, "user");
    return Response.json({ connected: true, hint });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed to save key." }, { status: 400 });
  }
}

export async function PATCH(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const body = await readJson(req);
  const project = await ownedProject(user.id, body.projectId);
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  const denied = await requireWorkspaceEditor(user.id, project.workspaceId);
  if (denied) return denied;
  const cents = Number(body.monthlyCapCents);
  try {
    await updateSpendCap(prisma, project.workspaceId, cents, "user");
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed to update cap." }, { status: 400 });
  }
}

export async function DELETE(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const project = await ownedProject(user.id, new URL(req.url).searchParams.get("projectId"));
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  const denied = await requireWorkspaceEditor(user.id, project.workspaceId);
  if (denied) return denied;
  await revokeHiggsfieldKey(prisma, project.workspaceId, "user");
  return Response.json({ connected: false });
}
