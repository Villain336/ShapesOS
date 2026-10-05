// ShapesOS — submit a social post for approval (Phase 4b).
// POST /api/social/posts/[id]/submit → { post } (editor+)
// Validates text/media against every target platform, then puts the post in
// the unified approval inbox (source "social") and notifies approvers.

import { submitForApproval } from "@/lib/social/publications";
import { checkRateLimitAsync, tooManyRequests } from "@/lib/api/rate-limit";
import { guardWorkspace, socialError } from "../../../_lib";
import { sidecarScoped } from "@/lib/integrations/sidecar-scope";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function handlePOST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
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

// Phase 15.1: run in this workspace's sidecar scope — its own instance;
// a shared one is refused on hosted (lib/integrations/sidecar-tenancy.ts).
export const POST = sidecarScoped(handlePOST);
