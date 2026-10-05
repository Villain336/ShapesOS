// ShapesOS — GET /api/approvals/inbox[?source=mission,spend]
//
// The unified "needs you" inbox: pending items from every human-approval
// queue the viewer's role can read, newest first. Read-only — each item
// carries a deep link to its queue's approve/deny UI and, where the queue's
// API supports it cleanly, inline approve/deny actions.

import { errorResponse } from "@/lib/api/errors";
import { loadInbox } from "@/lib/approvals/inbox";
import { isInboxSource, type InboxSourceKey } from "@/lib/approvals/types";
import { inboxGuard } from "../_lib";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const viewer = await inboxGuard();
  if (viewer instanceof Response) return viewer;
  const raw = new URL(req.url).searchParams.get("source");
  const sources = raw
    ? raw
        .split(",")
        .map((s) => s.trim())
        .filter(isInboxSource)
    : undefined;
  if (raw && sources && sources.length === 0) {
    return Response.json({ error: "Unknown source." }, { status: 400 });
  }
  try {
    const result = await loadInbox(viewer, { sources: sources as InboxSourceKey[] | undefined });
    return Response.json({ ...result, role: viewer.role });
  } catch (e) {
    return errorResponse(e, "GET /api/approvals/inbox");
  }
}
