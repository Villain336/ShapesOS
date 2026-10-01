// Marketr — E-sign module API.
// POST   /api/esign/vault/[entryId]/legal-hold — set a legal hold (blocks retention purge).
// DELETE /api/esign/vault/[entryId]/legal-hold — release the hold.

import { z } from "zod";
import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { setLegalHold, releaseLegalHold } from "@/lib/esign/vault";
import { EsignGateError } from "@/lib/esign/envelopes";

export const dynamic = "force-dynamic";

const BodySchema = z.object({ reason: z.string().min(1).max(500) });

export async function POST(req: Request, ctx: { params: Promise<{ entryId: string }> }) {
  try {
    const { user, workspace } = await guardWorkspace({ editor: true });
    const { entryId } = await ctx.params;
    const parsed = BodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: "A legal hold needs a reason." }, { status: 400 });
    const entry = await setLegalHold(prisma, {
      entryId,
      workspaceId: workspace.id,
      reason: parsed.data.reason,
      actor: user.id,
    });
    return Response.json({ legalHold: entry.legalHold, legalHoldReason: entry.legalHoldReason });
  } catch (e) {
    if (e instanceof EsignGateError) {
      const status = e.code === "unknown_vault_entry" ? 404 : 422;
      return Response.json({ error: e.message, code: e.code }, { status });
    }
    return httpErrorResponse(e);
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ entryId: string }> }) {
  try {
    const { user, workspace } = await guardWorkspace({ editor: true });
    const { entryId } = await ctx.params;
    const entry = await releaseLegalHold(prisma, { entryId, workspaceId: workspace.id, actor: user.id });
    return Response.json({ legalHold: entry.legalHold });
  } catch (e) {
    if (e instanceof EsignGateError) {
      const status = e.code === "unknown_vault_entry" ? 404 : 422;
      return Response.json({ error: e.message, code: e.code }, { status });
    }
    return httpErrorResponse(e);
  }
}
