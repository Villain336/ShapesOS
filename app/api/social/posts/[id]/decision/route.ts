// ShapesOS — approve or deny a social post (Phase 4b).
// POST /api/social/posts/[id]/decision { decision: "approve" | "deny", note? } → { post }
// Editor+, and not your own submission while another approver exists
// (separation of duties, same rule the inbox shows). Approve dispatches to
// the social provider right away (Postiz schedules future posts itself).

import { z } from "zod";
import { validateBody } from "@/lib/api/validate";
import { getMembership } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { hasOtherApprover } from "@/lib/approvals/inbox";
import { decidePost } from "@/lib/social/publications";
import { getSocialProvider } from "@/lib/social/provider";
import { checkRateLimitAsync, tooManyRequests } from "@/lib/api/rate-limit";
import { ForbiddenError } from "@/lib/api/errors";
import { guardWorkspace, readJson, socialError } from "../../../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Body = z.object({
  decision: z.enum(["approve", "deny"]),
  note: z.string().trim().max(1000).optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { user, workspace } = await guardWorkspace({ editor: true });
    const rl = await checkRateLimitAsync(`postiz-post:ws:${workspace.id}`, "write");
    if (!rl.allowed) return tooManyRequests(rl.retryAfterMs);
    const v = validateBody(Body, await readJson(req));
    if (!v.ok) return v.error;
    const membership = await getMembership(user.id, workspace.id);
    if (!membership) throw new ForbiddenError("Insufficient role for this action.");
    const { id } = await ctx.params;
    const post = await decidePost(
      workspace.id,
      id,
      { userId: user.id, role: membership.role, hasOtherApprover: await hasOtherApprover(prisma, workspace.id, user.id) },
      v.data.decision,
      v.data.note ?? null,
      getSocialProvider(workspace.id),
    );
    return Response.json({ post });
  } catch (e) {
    return socialError(e);
  }
}
