// Marketr — E-sign module API.
// POST /api/esign/envelopes/[id]/refresh — re-read vendor status; recover a
// missing sealed PDF on completed envelopes.

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { createDocumensoVendor } from "@/lib/esign/documenso-vendor";
import { EsignGateError, refreshEnvelope } from "@/lib/esign/envelopes";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { workspace } = await guardWorkspace();
    const { id } = await ctx.params;
    const vendor = createDocumensoVendor();
    const updated = await refreshEnvelope(prisma, vendor, id, workspace.id);
    return Response.json({
      envelope: {
        id: updated.id,
        status: updated.status,
        vendorStatus: updated.vendorStatus,
        sealedPdfFetched: !!updated.sealedPdf,
      },
    });
  } catch (e) {
    if (e instanceof EsignGateError) {
      return Response.json({ error: e.message, code: e.code }, { status: 404 });
    }
    return httpErrorResponse(e);
  }
}
