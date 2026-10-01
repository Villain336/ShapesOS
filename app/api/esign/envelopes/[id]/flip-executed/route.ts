// Marketr — E-sign module API.
// POST /api/esign/envelopes/[id]/flip-executed — record the contract's
// executed-state flip. Only a completed, sealed, contract-linked envelope
// can flip.

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { flipContractExecuted } from "@/lib/esign/legal";
import { EsignGateError } from "@/lib/esign/envelopes";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { user, workspace } = await guardWorkspace({ editor: true });
    const { id } = await ctx.params;
    const flip = await flipContractExecuted(prisma, {
      envelopeId: id,
      workspaceId: workspace.id,
      actor: user.id,
    });
    return Response.json({ executed: true, ...flip });
  } catch (e) {
    if (e instanceof EsignGateError) {
      const status = e.code === "unknown_envelope" ? 404 : 422;
      return Response.json({ error: e.message, code: e.code }, { status });
    }
    return httpErrorResponse(e);
  }
}
