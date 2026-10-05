// ShapesOS — submit a social post for approval (Phase 4b).
// POST /api/social/posts/[id]/submit → { post } (editor+)
// Validates text/media against every target platform, then puts the post in
// the unified approval inbox (source "social") and notifies approvers.

import { submitForApproval } from "@/lib/social/publications";
import { checkRateLimitAsync, tooManyRequests } from "@/lib/api/rate-limit";
import { guardWorkspace, socialError } from "../../../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { user, workspace } = await guardWorkspace({ editor: true });
    const rl = await checkRateLimitAsync(`social-submit:ws:${workspace.id}`, "write");
    if (!rl.allowed) return tooManyRequests(rl.retryAfterMs);
    const { id } = await ctx.params;
    return Response.json({ post: await submitForApproval(workspace.id, id, user.id) });
  } catch (e) {
    return socialError(e);
  }
}
