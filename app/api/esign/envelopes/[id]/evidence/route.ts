// Marketr — E-sign module API.
// GET /api/esign/envelopes/[id]/evidence — the evidence pack: envelope,
// signers, hash-chained audit log, integrity verification, vault status.
// One package for counsel; the sealed PDF downloads separately.

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { buildEvidencePack } from "@/lib/esign/legal";
import { EsignGateError } from "@/lib/esign/envelopes";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { workspace } = await guardWorkspace();
    const { id } = await ctx.params;
    const pack = await buildEvidencePack(prisma, { envelopeId: id, workspaceId: workspace.id });
    return Response.json({ evidence: pack });
  } catch (e) {
    if (e instanceof EsignGateError) {
      const status = e.code === "unknown_envelope" ? 404 : 422;
      return Response.json({ error: e.message, code: e.code }, { status });
    }
    return httpErrorResponse(e);
  }
}
