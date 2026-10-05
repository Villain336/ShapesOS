// ShapesOS — GET /api/approvals/count → { total, actionable }
//
// Badge numbers for the "needs you" inbox: `actionable` is what this member
// can decide under each queue's own role rules (the badge shows it);
// `total` is everything visible to them.

import { errorResponse } from "@/lib/api/errors";
import { countInbox } from "@/lib/approvals/inbox";
import { inboxGuard } from "../_lib";

export const dynamic = "force-dynamic";

export async function GET() {
  const viewer = await inboxGuard();
  if (viewer instanceof Response) return viewer;
  try {
    const counts = await countInbox(viewer);
    return Response.json(counts, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    return errorResponse(e, "GET /api/approvals/count");
  }
}
