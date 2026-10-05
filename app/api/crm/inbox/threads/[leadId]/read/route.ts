// ShapesOS — CRM conversation inbox: read state (Phase 4b).
// POST /api/crm/inbox/threads/[leadId]/read { at?: ISO, unread?: boolean }
//   → { lastReadAt }   (viewer+; the caller's own marker only)
// `at` is the newest message the client has shown, so a message that arrived
// after the last poll stays unread. `unread: true` drops the marker.

import type { NextRequest } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { validateBody, z } from "@/lib/api/validate";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { markThreadRead, markThreadUnread } from "@/lib/crm/inbox";
import { inboxGuard } from "../../../_lib";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  at: z.string().trim().max(64).optional(),
  unread: z.boolean().optional(),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
  try {
    const ctx = await inboxGuard("viewer");
    const { leadId } = await params;
    const raw = await req.json().catch(() => ({}));
    const parsed = validateBody(BodySchema, raw);
    if (!parsed.ok) return parsed.error;
    const at = parsed.data.at ? new Date(parsed.data.at) : undefined;
    const opts = { workspaceId: ctx.workspaceId, userId: ctx.userId, leadId: String(leadId).slice(0, 64) };
    if (parsed.data.unread) {
      await withWorkspaceScope(ctx.workspaceId, (tx) => markThreadUnread(tx, opts));
      return Response.json({ lastReadAt: null });
    }
    const res = await withWorkspaceScope(ctx.workspaceId, (tx) => markThreadRead(tx, { ...opts, at }));
    return Response.json(res);
  } catch (err) {
    return errorResponse(err, "POST /api/crm/inbox/threads/[leadId]/read");
  }
}
