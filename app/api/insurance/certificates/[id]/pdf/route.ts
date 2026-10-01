// Marketr — Wave 2 Insurance slice 5: download the issued COI PDF.
// GET /api/insurance/certificates/[id]/pdf — serves the stored PDF bytes
// like the e-sign sealed-evidence route. 410 if the certificate was revoked
// or the artifact was purged.

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { workspace } = await guardWorkspace();
    const { id } = await ctx.params;
    const certificate = await prisma.insuranceCertificate.findFirst({
      where: { id, workspaceId: workspace.id },
      select: {
        pdfBytes: true,
        pdfHash: true,
        holderName: true,
        status: true,
        revokedReason: true,
      },
    });
    if (!certificate) {
      return Response.json({ error: "Certificate not found." }, { status: 404 });
    }
    if (certificate.status === "revoked") {
      return Response.json(
        {
          error: "This certificate was revoked — the PDF is no longer valid.",
          reason: certificate.revokedReason,
        },
        { status: 410 },
      );
    }
    if (!certificate.pdfBytes) {
      return Response.json(
        { error: "No issued PDF yet — the certificate has not been issued." },
        { status: 410 },
      );
    }
    const filename = `coi-${certificate.holderName.replace(/[^a-z0-9-_]+/gi, "-").slice(0, 40)}.pdf`;
    return new Response(Buffer.from(certificate.pdfBytes), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "X-Certificate-Pdf-Hash": certificate.pdfHash ?? "",
      },
    });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
