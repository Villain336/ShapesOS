// Marketr — newsletter API: workspace settings / BYO Resend key (milestone 19).
// GET /api/newsletter/settings?workspaceId= → { resendKeyHint, defaultFromName } (key NEVER returned)
// POST /api/newsletter/settings { workspaceId, apiKey } → add/rotate key
// PATCH /api/newsletter/settings { workspaceId, defaultFromName }

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { getSettings, setResendKey } from "@/lib/newsletter/service";
import { requireWorkspaceEditor, readJson } from "../_lib";

async function workspaceOf(userId: string, workspaceId: unknown) {
  if (typeof workspaceId !== "string" || !workspaceId) return null;
  const m = await prisma.workspace.findFirst({
    where: { id: workspaceId, members: { some: { userId } } },
    select: { id: true },
  });
  return m;
}

export async function GET(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const ws = await workspaceOf(user.id, new URL(req.url).searchParams.get("workspaceId"));
  if (!ws) return Response.json({ error: "Workspace not found" }, { status: 404 });
  const denied = await requireWorkspaceEditor(user.id, ws.id);
  if (denied) return denied;
  const s = await getSettings(prisma, ws.id);
  return Response.json({ resendKeyHint: s.resendKeyHint, defaultFromName: s.defaultFromName });
}

export async function POST(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const body = await readJson(req);
  const ws = await workspaceOf(user.id, body.workspaceId);
  if (!ws) return Response.json({ error: "Workspace not found" }, { status: 404 });
  const denied = await requireWorkspaceEditor(user.id, ws.id);
  if (denied) return denied;
  if (typeof body.apiKey !== "string" || !body.apiKey.trim()) {
    return Response.json({ error: "API key is required." }, { status: 400 });
  }
  try {
    const { hint } = await setResendKey(prisma, ws.id, body.apiKey);
    return Response.json({ hint });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed to save key." }, { status: 400 });
  }
}

export async function PATCH(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const body = await readJson(req);
  const ws = await workspaceOf(user.id, body.workspaceId);
  if (!ws) return Response.json({ error: "Workspace not found" }, { status: 404 });
  const denied = await requireWorkspaceEditor(user.id, ws.id);
  if (denied) return denied;
  const name = typeof body.defaultFromName === "string" ? body.defaultFromName.trim().slice(0, 80) : null;
  await prisma.newsletterSettings.upsert({
    where: { workspaceId: ws.id },
    update: { defaultFromName: name || null },
    create: { workspaceId: ws.id, defaultFromName: name || null },
  });
  return Response.json({ ok: true });
}
