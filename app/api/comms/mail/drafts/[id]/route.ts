// ShapesOS — Phase 18.2 (WS=comms): one of your mail drafts.
//   PATCH  /api/comms/mail/drafts/[id] { to?, cc?, subject?, body? } → { draft }   (viewer+, your own)
//   DELETE /api/comms/mail/drafts/[id] → 204 (discarded)

import type { NextRequest } from "next/server";
import { errorResponse, HttpError } from "@/lib/api/errors";
import { validateBody, z } from "@/lib/api/validate";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { draftView } from "@/lib/comms/mail/agent.server";
import { mailGuard } from "../../_lib";

export const dynamic = "force-dynamic";

const Body = z.object({ to: z.string().max(4000).nullable().optional(), cc: z.string().max(4000).nullable().optional(), subject: z.string().max(998).nullable().optional(), body: z.string().max(200_000).optional() }).strict();

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await mailGuard("viewer");
    const { id } = await params;
    const parsed = validateBody(Body, await req.json());
    if (!parsed.ok) return parsed.error;
    const row = await withWorkspaceScope(ctx.workspaceId, async (tx) => {
      const d = await tx.mailDraft.findFirst({ where: { id: String(id), workspaceId: ctx.workspaceId, userId: ctx.userId, status: "draft" } });
      if (!d) throw new HttpError(404, "Draft not found.");
      return tx.mailDraft.update({ where: { id: d.id, workspaceId: ctx.workspaceId }, data: parsed.data });
    });
    return Response.json({ draft: draftView(row) });
  } catch (err) {
    return errorResponse(err, "PATCH /api/comms/mail/drafts/[id]");
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await mailGuard("viewer");
    const { id } = await params;
    const r = await withWorkspaceScope(ctx.workspaceId, (tx) =>
      tx.mailDraft.updateMany({ where: { id: String(id), workspaceId: ctx.workspaceId, userId: ctx.userId, status: "draft" }, data: { status: "discarded" } }),
    );
    if (r.count === 0) throw new HttpError(404, "Draft not found.");
    return new Response(null, { status: 204 });
  } catch (err) {
    return errorResponse(err, "DELETE /api/comms/mail/drafts/[id]");
  }
}
