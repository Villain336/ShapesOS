// Marketr — ad factory API: campaigns (milestone 21).
// GET /api/ads/campaigns?projectId= → campaigns with creative counts + spend
// POST /api/ads/campaigns { projectId, name, objective?, brandKitId?, channels? }

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { createCampaign, getCampaignSpend, listCampaigns } from "@/lib/ads/service";
import { ownedProject, readJson, requireEditor } from "../_lib";

export async function GET(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const project = await ownedProject(user.id, new URL(req.url).searchParams.get("projectId"));
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  const campaigns = await listCampaigns(prisma, project.id);
  const withSpend = await Promise.all(
    campaigns.map(async (c) => ({ ...c, spend: await getCampaignSpend(prisma, c.id) })),
  );
  return Response.json({ campaigns: withSpend });
}

export async function POST(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const body = await readJson(req);
  const project = await ownedProject(user.id, body.projectId);
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  const denied = await requireEditor(user.id, project.id);
  if (denied) return denied;
  try {
    const campaign = await createCampaign(
      prisma,
      project.workspaceId,
      project.id,
      {
        name: typeof body.name === "string" ? body.name : "",
        objective: typeof body.objective === "string" ? body.objective : undefined,
        brandKitId: typeof body.brandKitId === "string" ? body.brandKitId : null,
        channels: Array.isArray(body.channels) ? body.channels.map(String) : [],
      },
      "user",
    );
    return Response.json({ campaign });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed to create campaign." }, { status: 400 });
  }
}
