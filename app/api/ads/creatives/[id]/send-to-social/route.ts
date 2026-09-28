// Marketr — ad factory API: send an approved creative to social (Wave B).
// POST /api/ads/creatives/[id]/send-to-social { projectId, text, channelIds, platformTypes? }
// Queues a Postiz DRAFT — never publishes. A human approves the draft in
// Postiz (or the Social tab). Draft-first is load-bearing: the shared
// queuePostizDraft helper hardcodes type "draft".

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { sendCreativeToSocial } from "@/lib/ads/service";
import { ownedProject, readJson, requireEditor } from "../../../_lib";
import { checkRateLimit, tooManyRequests } from "@/lib/api/rate-limit";

export const dynamic = "force-dynamic";

export const BodySchema = z.object({
  projectId: z.string().trim().min(1).max(120),
  text: z.string().trim().min(1).max(10_000),
  channelIds: z.array(z.string().trim().min(1).max(120)).min(1).max(30),
  platformTypes: z.record(z.string(), z.string().trim().min(1).max(64)).optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const parsed = BodySchema.safeParse(await readJson(req));
  if (!parsed.success) {
    return Response.json({ error: "Invalid input", issues: parsed.error.issues }, { status: 400 });
  }
  const body = parsed.data;
  const project = await ownedProject(user.id, body.projectId);
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  const denied = await requireEditor(user.id, project.id);
  if (denied) return denied;
  // Same write-tier protection as the other Postiz draft routes — queueing a
  // draft is a real-world write against platform quota.
  const rl = checkRateLimit(`postiz-post:ws:${project.workspaceId}`, "write");
  if (!rl.allowed) return tooManyRequests(rl.retryAfterMs);
  try {
    const draft = await sendCreativeToSocial(
      prisma,
      project.workspaceId,
      project.id,
      id,
      {
        text: body.text,
        channelIds: body.channelIds,
        platformTypes: body.platformTypes,
      },
      "user",
    );
    return Response.json({ postizRef: draft.postizRef });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Send to social failed." }, { status: 400 });
  }
}
