// Marketr — Postiz sidecar: posts (Phase 12).
// GET  /api/integrations/postiz/posts?from=&to= → { posts }
// POST /api/integrations/postiz/posts { type: "draft", content, channelIds, platformTypes? }
//   → creates a Postiz DRAFT via the public API (raw fetch, no SDK).
// Phase 4b: publishing ("now"/"schedule") goes through the ShapesOS social
// composer (/api/social/posts → submit → approval inbox) only; this legacy
// route no longer publishes, so it can't bypass approval. Those types → 409.

import { z } from "zod";
import { guardWorkspace, readJson, sidecarError } from "../../_lib";
import {
  listPostizPosts,
  schedulePostizPost,
  type PostizPostType,
} from "@/lib/integrations/postiz";
import { checkRateLimitAsync, tooManyRequests } from "@/lib/api/rate-limit";
import { sidecarScoped } from "@/lib/integrations/sidecar-scope";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PostSchema = z.object({
  type: z.enum(["now", "schedule", "draft"]),
  date: z.string().trim().optional(),
  content: z.string().trim().min(1).max(10_000),
  channelIds: z.array(z.string().trim().min(1)).min(1).max(30),
  platformTypes: z.record(z.string(), z.string().trim().min(1).max(64)).optional(),
});

async function handleGET(req: Request) {
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

async function handlePOST(req: Request) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    // Publish protection: per-workspace write-tier limit on top of the
    // proxy's write tier — publishing is real-world and costs platform quota.
    const rl = await checkRateLimitAsync(`postiz-post:ws:${workspace.id}`, "write");
    if (!rl.allowed) return tooManyRequests(rl.retryAfterMs);

    const parsed = PostSchema.safeParse(await readJson(req));
    if (!parsed.success) {
      return Response.json({ error: "Invalid input", issues: parsed.error.issues }, { status: 400 });
    }
    const d = parsed.data;
    if (d.type !== "draft") {
      return Response.json(
        {
          error: "Publishing needs approval. Create the post in Social and submit it for approval.",
          code: "approval_required",
        },
        { status: 409 },
      );
    }
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

// Phase 15.1: run in this workspace's sidecar scope — its own instance;
// a shared one is refused on hosted (lib/integrations/sidecar-tenancy.ts).
export const GET = sidecarScoped(handleGET);
export const POST = sidecarScoped(handlePOST);
