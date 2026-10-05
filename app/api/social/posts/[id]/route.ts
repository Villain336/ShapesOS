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

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { workspace } = await guardWorkspace();
    const { id } = await ctx.params;
    return Response.json({ post: await getPost(workspace.id, id) });
  } catch (e) {
    return socialError(e);
  }
}

export async function PATCH(req: Request, ctx: Ctx) {
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

export async function DELETE(_req: Request, ctx: Ctx) {
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
