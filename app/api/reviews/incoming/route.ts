// Marketr — R4: monitored reviews needing responses.
// GET  /api/reviews/incoming → M16 reviews with responded=false + latest
//        approval state for any AI-drafted reply.
// POST /api/reviews/[id]/draft-response (editor+) → generate draft reply with
//        the "copy" workload LLM and create an ApprovalItem (kind
//        "review_response"). Approve via /api/messaging/approvals (messaging).

import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import { listIncomingReviews, draftReviewResponse, ResponderError } from "@/lib/reviews/responder";

async function guard(reqRole: "viewer" | "editor" = "viewer") {
  const user = await requireUser();
  if (!user) return { error: Response.json({ error: "Unauthorized" }, { status: 401 }) as Response };
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, reqRole))) {
    return { error: forbidden() as Response };
  }
  return { user, workspace };
}

export async function GET(req: Request) {
  const g = await guard("viewer");
  if (g.error) return g.error;
  const url = new URL(req.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10) || 50, 200);
  const reviews = await listIncomingReviews(g.workspace!.id, { limit });
  return Response.json({ reviews, workspaceId: g.workspace!.id });
}
