// Marketr — ad factory API: generate creatives (milestone 21).
// POST /api/ads/creatives { projectId, campaignId, brief, type, aspectRatio,
//   channels?, variants, referenceImageUrl?, modelPath?, name? }
// → creates N creative rows and submits provider jobs. Editor+ only.

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { generateCreatives } from "@/lib/ads/service";
import { type AdBrief, type AspectRatio } from "@/lib/ads/brief";
import { ownedProject, readJson, requireEditor, workspacePort } from "../_lib";

export async function POST(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const body = await readJson(req);
  const project = await ownedProject(user.id, body.projectId);
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  const denied = await requireEditor(user.id, project.id);
  if (denied) return denied;
  const ported = await workspacePort(project.workspaceId);
  if ("response" in ported) return ported.response;

  const brief = (body.brief ?? {}) as AdBrief;
  const type = body.type === "video" ? "video" : "image";
  const aspectRatio = (typeof body.aspectRatio === "string" ? body.aspectRatio : "1:1") as AspectRatio;

  try {
    const result = await generateCreatives(
      prisma,
      project.workspaceId,
      project.id,
      String(body.campaignId ?? ""),
      {
        brief,
        type,
        aspectRatio,
        channels: Array.isArray(body.channels) ? body.channels.map(String) : [],
        variants: Number(body.variants ?? 4),
        referenceImageUrl: typeof body.referenceImageUrl === "string" ? body.referenceImageUrl : undefined,
        modelPath: typeof body.modelPath === "string" && body.modelPath ? body.modelPath : undefined,
        name: typeof body.name === "string" ? body.name : undefined,
      },
      ported.port,
      "user",
    );
    return Response.json(result);
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Generation failed." }, { status: 400 });
  }
}
