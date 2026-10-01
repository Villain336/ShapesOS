// Marketr — E-sign module API.
// POST /api/esign/envelopes/[id]/link-contract — bind an envelope to a
// contract object (generic refs until the legal module lands).

import { z } from "zod";
import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { linkContract } from "@/lib/esign/legal";
import { EsignGateError } from "@/lib/esign/envelopes";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  contractType: z.string().min(1).max(80),
  contractRef: z.string().min(1).max(200),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { user, workspace } = await guardWorkspace({ editor: true });
    const { id } = await ctx.params;
    const parsed = BodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: "A contract type and reference are required." }, { status: 400 });
    const updated = await linkContract(prisma, {
      envelopeId: id,
      workspaceId: workspace.id,
      contractType: parsed.data.contractType,
      contractRef: parsed.data.contractRef,
      actor: user.id,
    });
    return Response.json({
      envelopeId: updated.id,
      contractType: updated.contractType,
      contractRef: updated.contractRef,
    });
  } catch (e) {
    if (e instanceof EsignGateError) {
      const status = e.code === "unknown_envelope" ? 404 : 422;
      return Response.json({ error: e.message, code: e.code }, { status });
    }
    return httpErrorResponse(e);
  }
}
