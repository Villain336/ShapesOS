// Marketr — Postiz sidecar: posts (Phase 12).
// GET  /api/integrations/postiz/posts?from=&to= → { posts }
// POST /api/integrations/postiz/posts { type: "now"|"schedule"|"draft", date?, content, channelIds, platformTypes? }
//   → schedules or publishes via the Postiz public API (raw fetch, no SDK).
// Publishing is a real-world action: the UI confirms before calling this.

import { z } from "zod";
import { guardWorkspace, readJson, sidecarError } from "../../_lib";
import {
  listPostizPosts,
  schedulePostizPost,
  type PostizPostType,
} from "@/lib/integrations/postiz";
import { checkRateLimit, tooManyRequests } from "@/lib/api/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PostSchema = z.object({
  type: z.enum(["now", "schedule", "draft"]),
  date: z.string().trim().optional(),
  content: z.string().trim().min(1).max(10_000),
  channelIds: z.array(z.string().trim().min(1)).min(1).max(30),
  platformTypes: z.record(z.string(), z.string().trim().min(1).max(64)).optional(),
});

export async function GET(req: Request) {
  try {
    await guardWorkspace();
    const sp = new URL(req.url).searchParams;
    return Response.json({
      posts: await listPostizPosts({
        from: sp.get("from") ?? undefined,
        to: sp.get("to") ?? undefined,
      }),
    });
  } catch (e) {
    return sidecarError(e);
  }
}

export async function POST(req: Request) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    // Publish protection: per-workspace write-tier limit on top of the
    // proxy's write tier — publishing is real-world and costs platform quota.
    const rl = checkRateLimit(`postiz-post:ws:${workspace.id}`, "write");
    if (!rl.allowed) return tooManyRequests(rl.retryAfterMs);

    const parsed = PostSchema.safeParse(await readJson(req));
    if (!parsed.success) {
      return Response.json({ error: "Invalid input", issues: parsed.error.issues }, { status: 400 });
    }
    const d = parsed.data;
    const result = await schedulePostizPost({
      type: d.type as PostizPostType,
      date: d.date,
      content: d.content,
      channelIds: d.channelIds,
      platformTypes: d.platformTypes,
    });
    return Response.json({ ok: true, post: result }, { status: 201 });
  } catch (e) {
    return sidecarError(e);
  }
}
