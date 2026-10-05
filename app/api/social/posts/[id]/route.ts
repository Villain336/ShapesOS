// ShapesOS — one social post (Phase 4b).
// GET    /api/social/posts/[id] → { post } (viewer+)
// PATCH  /api/social/posts/[id] { …draft fields } → { post } (editor+; drafts and failed posts)
// DELETE /api/social/posts/[id] → deletes a draft/failed/cancelled post, or
//        cancels a pending/scheduled one (removing it from Postiz, best effort)

import { validateBody } from "@/lib/api/validate";
import { deleteOrCancelPost, getPost, updatePost } from "@/lib/social/publications";
import { deletePostizPost } from "@/lib/integrations/postiz";
import { log } from "@/lib/observability/log";
import { PostBodySchema, guardWorkspace, readJson, socialError, toChannels, toMedia } from "../../_lib";
import { sidecarScoped } from "@/lib/integrations/sidecar-scope";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

async function handleGET(_req: Request, ctx: Ctx) {
  try {
    const { workspace } = await guardWorkspace();
    const { id } = await ctx.params;
    return Response.json({ post: await getPost(workspace.id, id) });
  } catch (e) {
    return socialError(e);
  }
}

async function handlePATCH(req: Request, ctx: Ctx) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const { id } = await ctx.params;
    const v = validateBody(PostBodySchema, await readJson(req));
    if (!v.ok) return v.error;
    const post = await updatePost(workspace.id, id, {
      ...v.data,
      channels: toChannels(v.data.channels),
      media: toMedia(v.data.media),
    });
    return Response.json({ post });
  } catch (e) {
    return socialError(e);
  }
}

async function handleDELETE(_req: Request, ctx: Ctx) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const { id } = await ctx.params;
    const post = await getPost(workspace.id, id);
    if (post.status === "scheduled" && post.provider === "postiz") {
      for (const ref of post.providerRefs) {
        await deletePostizPost(ref.postId).catch((err: unknown) =>
          log.warn("postiz delete failed", { workspaceId: workspace.id, postId: id, error: err instanceof Error ? err.message : String(err) }),
        );
      }
    }
    return Response.json(await deleteOrCancelPost(workspace.id, id));
  } catch (e) {
    return socialError(e);
  }
}

// Phase 15.1: run in this workspace's sidecar scope — its own instance;
// a shared one is refused on hosted (lib/integrations/sidecar-tenancy.ts).
export const GET = sidecarScoped(handleGET);
export const PATCH = sidecarScoped(handlePATCH);
export const DELETE = sidecarScoped(handleDELETE);
