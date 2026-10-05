// ShapesOS — CRM conversation inbox: thread list (Phase 4b).
// GET /api/crm/inbox/threads?channel=sms|email&unread=1&assigned=any|me|unassigned&q=&cursor=&limit=
//   → { threads, nextCursor, unreadThreads, unmatchedInbound }   (viewer+)
// Unread state is the caller's own (conversation_reads, FORCE RLS).

import type { NextRequest } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { intQuery, parseQuery, z } from "@/lib/api/validate";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { listThreads } from "@/lib/crm/inbox";
import { inboxGuard } from "../_lib";

export const dynamic = "force-dynamic";

const QuerySchema = z.object({
  channel: z.enum(["sms", "email"]).optional(),
  unread: z.enum(["1", "true", "0", "false"]).optional(),
  assigned: z.enum(["any", "me", "unassigned"]).optional(),
  q: z.string().trim().max(120).optional(),
  cursor: z.string().trim().max(200).optional(),
  limit: intQuery(30, 1, 100),
});

export async function GET(req: NextRequest) {
  try {
    const ctx = await inboxGuard("viewer");
    const parsed = parseQuery(QuerySchema, req.nextUrl.searchParams);
    if (!parsed.ok) return parsed.error;
    const d = parsed.data;
    const list = await withWorkspaceScope(ctx.workspaceId, (tx) =>
      listThreads(tx, {
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        channel: d.channel ?? null,
        unread: d.unread === "1" || d.unread === "true",
        assigned: d.assigned ?? "any",
        q: d.q ?? null,
        cursor: d.cursor ?? null,
        limit: d.limit,
      }),
    );
    return Response.json(list, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err, "GET /api/crm/inbox/threads");
  }
}
