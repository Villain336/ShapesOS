// Marketr — R4: manually mark a review request completed (editor+).
// POST /api/review-requests/[id]/complete
// For customer-driven completion see the public token route:
// POST /api/review-requests/by-token/[token]/complete

import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import { markRequestCompleted, ReviewEngineError } from "@/lib/reviews/engine";

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "editor"))) return forbidden();

  const { id } = await ctx.params;
  try {
    const req = await markRequestCompleted(id, workspace.id, { manual: true });
    return Response.json({ reviewRequest: req });
  } catch (e) {
    if (e instanceof ReviewEngineError) {
      return Response.json({ error: e.message, code: e.code }, { status: 404 });
    }
    throw e;
  }
}
