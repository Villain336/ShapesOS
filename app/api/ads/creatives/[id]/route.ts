// Marketr — ad factory API: single creative review actions (milestone 21).
// GET /api/ads/creatives/[id]?projectId= → creative detail (incl. prompt history)
// PATCH /api/ads/creatives/[id] { projectId, action: approve|reject|cancel }

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { approveCreative, cancelCreative, rejectCreative } from "@/lib/ads/service";
import { ownedProject, readJson, requireEditor } from "../../_lib";

async function ownedCreative(userId: string, id: string, projectId: unknown) {
  const project = await ownedProject(userId, projectId);
  if (!project) return null;
  const creative = await prisma.adCreative.findFirst({
    where: { id, projectId: project.id },
    include: { campaign: { select: { id: true, name: true } } },
  });
  return creative ? { project, creative } : null;
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const found = await ownedCreative(user.id, id, new URL(req.url).searchParams.get("projectId"));
  if (!found) return Response.json({ error: "Creative not found" }, { status: 404 });
  return Response.json({ creative: found.creative });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const body = await readJson(req);
  const found = await ownedCreative(user.id, id, body.projectId);
  if (!found) return Response.json({ error: "Creative not found" }, { status: 404 });
  const denied = await requireEditor(user.id, found.project.id);
  if (denied) return denied;
  const action = String(body.action ?? "");
  try {
    if (action === "approve") {
      const creative = await approveCreative(prisma, found.project.workspaceId, id, "user");
      return Response.json({ creative });
    }
    if (action === "reject") {
      const creative = await rejectCreative(prisma, found.project.workspaceId, id, "user");
      return Response.json({ creative });
    }
    if (action === "cancel") {
      const creative = await cancelCreative(prisma, found.project.workspaceId, id, "user");
      return Response.json({ creative });
    }
    return Response.json({ error: "Unknown action. Use approve, reject, or cancel." }, { status: 400 });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Action failed." }, { status: 400 });
  }
}
