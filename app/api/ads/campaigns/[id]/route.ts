// Marketr — ad factory API: single campaign (milestone 21).
// GET /api/ads/campaigns/[id]?projectId= → campaign + creatives + spend
// PATCH /api/ads/campaigns/[id] { projectId, ... } → update
// DELETE /api/ads/campaigns/[id]?projectId= → delete (cascades creatives)

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { deleteCampaign, getCampaignSpend, updateCampaign } from "@/lib/ads/service";
import { ownedProject, readJson, requireEditor } from "../../_lib";

async function ownedCampaign(userId: string, id: string, projectId: unknown) {
  const project = await ownedProject(userId, projectId);
  if (!project) return null;
  const campaign = await prisma.adCampaign.findFirst({
    where: { id, projectId: project.id },
    include: { creatives: { orderBy: { createdAt: "desc" }, take: 100 } },
  });
  return campaign ? { project, campaign } : null;
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const found = await ownedCampaign(user.id, id, new URL(req.url).searchParams.get("projectId"));
  if (!found) return Response.json({ error: "Campaign not found" }, { status: 404 });
  const spend = await getCampaignSpend(prisma, found.campaign.id);
  return Response.json({ campaign: found.campaign, spend });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const body = await readJson(req);
  const found = await ownedCampaign(user.id, id, body.projectId);
  if (!found) return Response.json({ error: "Campaign not found" }, { status: 404 });
  const denied = await requireEditor(user.id, found.project.id);
  if (denied) return denied;
  try {
    const campaign = await updateCampaign(
      prisma,
      found.project.workspaceId,
      id,
      {
        ...(body.name !== undefined ? { name: String(body.name) } : {}),
        ...(body.objective !== undefined ? { objective: body.objective === null ? null : String(body.objective) } : {}),
        ...(body.brandKitId !== undefined ? { brandKitId: body.brandKitId === null ? null : String(body.brandKitId) } : {}),
        ...(body.channels !== undefined ? { channels: Array.isArray(body.channels) ? body.channels.map(String) : [] } : {}),
      },
      "user",
    );
    return Response.json({ campaign });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed to update campaign." }, { status: 400 });
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const found = await ownedCampaign(user.id, id, new URL(req.url).searchParams.get("projectId"));
  if (!found) return Response.json({ error: "Campaign not found" }, { status: 404 });
  const denied = await requireEditor(user.id, found.project.id);
  if (denied) return denied;
  try {
    await deleteCampaign(prisma, found.project.workspaceId, id, "user");
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed to delete campaign." }, { status: 400 });
  }
}
