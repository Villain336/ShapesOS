// Marketr — E-sign module API.
// POST /api/esign/envelopes/[id]/clone — re-send an expired/declined envelope
// as a FRESH DRAFT (same source bytes, signers, fields). The clone re-enters
// the human send gate; the original is untouched.

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { cloneAsDraft } from "@/lib/esign/agent";
import { EsignGateError } from "@/lib/esign/envelopes";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { user, workspace } = await guardWorkspace({ editor: true });
    const { id } = await ctx.params;
    const res = await cloneAsDraft(prisma, { envelopeId: id, workspaceId: workspace.id, actor: user.id });
    return Response.json(res);
  } catch (e) {
    if (e instanceof EsignGateError) {
      const status = e.code === "unknown_envelope" ? 404 : 422;
      return Response.json({ error: e.message, code: e.code }, { status });
    }
    return httpErrorResponse(e);
  }
}
