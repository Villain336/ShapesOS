// Marketr — ad factory API: send an approved creative to the M20 social studio.
// POST /api/ads/creatives/[id]/send-to-social { projectId, text, services, scheduledFor? }
// Creates a social post draft/scheduled post with the creative's assets attached.

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { sendCreativeToSocial } from "@/lib/ads/service";
import { ownedProject, readJson, requireEditor } from "../../../_lib";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const body = await readJson(req);
  const project = await ownedProject(user.id, body.projectId);
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  const denied = await requireEditor(user.id, project.id);
  if (denied) return denied;
  try {
    const post = await sendCreativeToSocial(
      prisma,
      project.workspaceId,
      project.id,
      id,
      {
        text: typeof body.text === "string" ? body.text : "",
        services: Array.isArray(body.services) ? body.services.map(String) : [],
        scheduledFor: typeof body.scheduledFor === "string" ? body.scheduledFor : null,
      },
      "user",
    );
    return Response.json({ post });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Send to social failed." }, { status: 400 });
  }
}
