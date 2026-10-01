// Marketr — E-sign module API.
// GET /api/esign/envelopes/[id]/evidence/pdf — download the sealed PDF.
// The evidence pack binds this download to its hash.

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { workspace } = await guardWorkspace();
    const { id } = await ctx.params;
    const envelope = await prisma.esignEnvelope.findFirst({
      where: { id, workspaceId: workspace.id },
      select: { sealedPdf: true, sealedPdfHash: true, title: true },
    });
    if (!envelope) return Response.json({ error: "Envelope not found." }, { status: 404 });
    if (!envelope.sealedPdf) {
      return Response.json({ error: "No sealed PDF — it may have been purged under retention." }, { status: 410 });
    }
    const filename = `${(envelope.title || "envelope").replace(/[^a-z0-9-_]+/gi, "-").slice(0, 60)}-sealed.pdf`;
    return new Response(Buffer.from(envelope.sealedPdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "X-Sealed-Pdf-Hash": envelope.sealedPdfHash ?? "",
      },
    });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
