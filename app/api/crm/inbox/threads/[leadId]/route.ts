// ShapesOS — CRM conversation inbox: one lead's thread (Phase 4b).
// GET /api/crm/inbox/threads/[leadId]?channel=sms|email
//   → { thread: { lead, messages, lastReadAt, unreadCount, lastEmailSubject }, consent }   (viewer+)
// Reading does not mark the thread read; the client posts to ./read.

import type { NextRequest } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { getThread, isInboxChannel } from "@/lib/crm/inbox";
import { getConsent } from "@/lib/messaging/consent";
import { inboxGuard } from "../../_lib";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
  try {
    const ctx = await inboxGuard("viewer");
    const { leadId } = await params;
    const channel = req.nextUrl.searchParams.get("channel");
    const thread = await withWorkspaceScope(ctx.workspaceId, (tx) =>
      getThread(tx, {
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        leadId: String(leadId).slice(0, 64),
        channel: isInboxChannel(channel) ? channel : null,
      }),
    );
    // Consent decides whether a reply can go out; show it before composing.
    const [sms, email] = await Promise.all([
      getConsent(ctx.workspaceId, thread.lead.id, "sms"),
      getConsent(ctx.workspaceId, thread.lead.id, "email"),
    ]);
    return Response.json({ thread, consent: { sms, email } }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err, "GET /api/crm/inbox/threads/[leadId]");
  }
}
