// ShapesOS — CRM conversation inbox: reply (Phase 4b).
// POST /api/crm/inbox/threads/[leadId]/reply { channel: "sms"|"email", subject?, body }
//   → 201 { message, outcome: "queued"|"sent"|"suppressed"|"failed" }   (editor+)
//
// Never sends directly: the reply goes through the messaging dispatcher's
// queueMessage() — the same path as POST /api/messaging/send — so consent,
// quiet hours, the daily cap and the human-approval gate all apply. The
// requester is the caller, so the approval-decided notification comes back
// to them.

import type { NextRequest } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { validateBody, z } from "@/lib/api/validate";
import { scopedDb, withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { markThreadRead, replyToThread, type QueueReplyFn } from "@/lib/crm/inbox";
import { queueMessage } from "@/lib/messaging/dispatcher";
import { inboxGuard } from "../../../_lib";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  channel: z.enum(["sms", "email"]),
  subject: z.string().trim().max(200).optional(),
  body: z.string().trim().min(1).max(5000),
});

const queue: QueueReplyFn = (input) => queueMessage(input);

export async function POST(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
  try {
    const ctx = await inboxGuard("editor");
    const { leadId } = await params;
    const parsed = validateBody(BodySchema, await req.json());
    if (!parsed.ok) return parsed.error;
    const opts = { workspaceId: ctx.workspaceId, userId: ctx.userId, leadId: String(leadId).slice(0, 64) };
    const result = await replyToThread(scopedDb(ctx.workspaceId), queue, { ...opts, ...parsed.data });
    // You replied, so you've read it.
    await withWorkspaceScope(ctx.workspaceId, (tx) => markThreadRead(tx, opts)).catch(() => {});
    return Response.json(result, { status: 201 });
  } catch (err) {
    return errorResponse(err, "POST /api/crm/inbox/threads/[leadId]/reply");
  }
}
