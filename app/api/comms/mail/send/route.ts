// ShapesOS — Phase 18.2 (WS=comms): send from the Mail app.
//   POST /api/comms/mail/send { threadKey?, connectionId?, to?, cc?, subject?, body, channel?, replyToMessageId?, draftId? }
//     → { outcome: sent | queued | suppressed | failed | mock, source, detail }
// Your click is the confirmation. It goes through the existing send action of
// its source (lib/comms/mail/send.server.ts): your own mailbox's
// send_email / reply_to_message (viewer+, your mailbox only), the CRM reply
// (editor+, consent / quiet hours / approval gate) or a Zernio DM on an
// account the workspace owns (editor+).

import type { NextRequest } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { validateBody, z } from "@/lib/api/validate";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { sendMail } from "@/lib/comms/mail/send.server";
import { mailGuard } from "../_lib";

export const dynamic = "force-dynamic";

const Body = z.object({
  threadKey: z.string().max(900).nullable().optional(),
  connectionId: z.string().max(64).nullable().optional(),
  to: z.string().max(4000).nullable().optional(),
  cc: z.string().max(4000).nullable().optional(),
  subject: z.string().max(998).nullable().optional(),
  body: z.string().min(1).max(200_000),
  channel: z.enum(["sms", "email"]).nullable().optional(),
  replyToMessageId: z.string().max(1024).nullable().optional(),
  draftId: z.string().max(64).nullable().optional(),
});

export async function POST(req: NextRequest) {
  try {
    const ctx = await mailGuard("viewer");
    const parsed = validateBody(Body, await req.json());
    if (!parsed.ok) return parsed.error;
    const b = parsed.data;
    const out = await sendMail({ workspaceId: ctx.workspaceId, userId: ctx.userId, role: ctx.role, by: "person" }, { ...b, idempotencySeed: b.draftId ?? null });
    if (b.draftId) {
      await withWorkspaceScope(ctx.workspaceId, (tx) =>
        tx.mailDraft.updateMany({ where: { id: b.draftId!, workspaceId: ctx.workspaceId, userId: ctx.userId }, data: { status: out.outcome === "failed" ? "failed" : "sent", sentAt: new Date() } }),
      );
    }
    return Response.json(out);
  } catch (err) {
    return errorResponse(err, "POST /api/comms/mail/send");
  }
}
