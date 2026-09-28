// Marketr — Phase 13C: hand a rendered clip to Postiz as a DRAFT.
//
// POST /api/clipper/clips/[id]/to-postiz {channelIds, content?, platformTypes?}
//
// DRAFT-FIRST IS LOAD-BEARING. This route NEVER publishes. It calls
// queueClipDraftToPostiz() — the only Postiz path in the clipper — which
// hardcodes type "draft". No user action in this module can trigger a live
// publish ("now"/"schedule" are unreachable by construction: the union type
// is not even imported here). A human approves the draft in Postiz itself.
//
// Sets clip.status = "queued" and stores the Postiz draft id as postizRef.

import { z } from "zod";
import { guardWorkspace, readJson, sidecarError } from "../../../../integrations/_lib";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { queueClipDraftToPostiz } from "../../../_postiz-choke";
import { checkRateLimit, tooManyRequests } from "@/lib/api/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BodySchema = z.object({
  channelIds: z.array(z.string().trim().min(1)).min(1).max(30),
  content: z.string().trim().min(1).max(10_000).optional(),
  platformTypes: z.record(z.string(), z.string().trim().min(1).max(64)).optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    // Same write-tier protection as the direct Postiz posts route — queueing
    // a draft is still a real-world write against platform quota.
    const rl = checkRateLimit(`postiz-post:ws:${workspace.id}`, "write");
    if (!rl.allowed) return tooManyRequests(rl.retryAfterMs);

    const { id } = await ctx.params;
    const parsed = BodySchema.safeParse(await readJson(req));
    if (!parsed.success) {
      return Response.json({ error: "Invalid input", issues: parsed.error.issues }, { status: 400 });
    }

    const clip = await withWorkspaceScope(workspace.id, (tx) =>
      tx.clip.findUnique({
        where: { id },
        include: { source: { select: { title: true } } },
      }),
    );
    if (!clip) return Response.json({ error: "Clip not found." }, { status: 404 });
    if (clip.renderStatus !== "ready" || !clip.outputRef) {
      return Response.json(
        { error: "Clip has no rendered output yet. Render it first." },
        { status: 409 },
      );
    }

    // Draft body: explicit content wins; otherwise derive from captions.
    const caps = (clip.captions ?? {}) as { segments?: Array<{ text?: string }> };
    const captionText = Array.isArray(caps.segments)
      ? caps.segments.map((s) => String(s?.text ?? "")).join(" ").replace(/\s+/g, " ").trim()
      : "";
    const content =
      parsed.data.content ??
      (captionText.length > 0
        ? captionText
        : `Clip from "${clip.source.title}" (${Math.round(clip.startSec)}s-${Math.round(clip.endSec)}s)`);

    // THE CHOKE POINT: draft only, hardcoded inside queueClipDraftToPostiz().
    const queued = await queueClipDraftToPostiz({
      channelIds: parsed.data.channelIds,
      content,
      platformTypes: parsed.data.platformTypes,
    });

    const updated = await withWorkspaceScope(workspace.id, (tx) =>
      tx.clip.update({
        where: { id },
        data: { status: "queued", postizRef: queued.postizRef },
      }),
    );
    return Response.json({ clip: updated, postizRef: queued.postizRef });
  } catch (e) {
    return sidecarError(e);
  }
}
