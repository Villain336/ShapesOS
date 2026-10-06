// ShapesOS — Phase 18.2 (WS=comms): your mail drafts (yours and the inbox agent's for you).
//   GET  /api/comms/mail/drafts[?threadKey=] → { drafts }   (viewer+, your own)
//   POST /api/comms/mail/drafts { source, threadKey?, connectionId?, to?, cc?, subject?, body } → 201 { draft }

import type { NextRequest } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { validateBody, z } from "@/lib/api/validate";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { draftView } from "@/lib/comms/mail/agent.server";
import { MAIL_SOURCES } from "@/lib/comms/mail/types";
import { mailGuard } from "../_lib";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const ctx = await mailGuard("viewer");
    const threadKey = req.nextUrl.searchParams.get("threadKey");
    const rows = await withWorkspaceScope(ctx.workspaceId, (tx) =>
      tx.mailDraft.findMany({
        where: { workspaceId: ctx.workspaceId, userId: ctx.userId, status: "draft", ...(threadKey ? { threadKey: threadKey.slice(0, 900) } : {}) },
        orderBy: { updatedAt: "desc" },
        take: 50,
      }),
    );
    return Response.json({ drafts: rows.map(draftView) });
  } catch (err) {
    return errorResponse(err, "GET /api/comms/mail/drafts");
  }
}

const Body = z.object({
  source: z.enum(MAIL_SOURCES),
  threadKey: z.string().max(900).nullable().optional(),
  connectionId: z.string().max(64).nullable().optional(),
  replyToMessageId: z.string().max(1024).nullable().optional(),
  to: z.string().max(4000).nullable().optional(),
  cc: z.string().max(4000).nullable().optional(),
  subject: z.string().max(998).nullable().optional(),
  body: z.string().max(200_000),
});

export async function POST(req: NextRequest) {
  try {
    const ctx = await mailGuard("viewer");
    const parsed = validateBody(Body, await req.json());
    if (!parsed.ok) return parsed.error;
    const b = parsed.data;
    const row = await withWorkspaceScope(ctx.workspaceId, (tx) =>
      tx.mailDraft.create({
        data: { workspaceId: ctx.workspaceId, userId: ctx.userId, source: b.source, threadKey: b.threadKey ?? null, connectionId: b.connectionId ?? null, replyToMessageId: b.replyToMessageId ?? null, to: b.to ?? null, cc: b.cc ?? null, subject: b.subject ?? null, body: b.body, origin: "person" },
      }),
    );
    return Response.json({ draft: draftView(row) }, { status: 201 });
  } catch (err) {
    return errorResponse(err, "POST /api/comms/mail/drafts");
  }
}
