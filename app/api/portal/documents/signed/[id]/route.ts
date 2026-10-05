// ShapesOS — Phase 10 (portal): GET /api/portal/documents/signed/[id] — the
// sealed PDF of a COMPLETED e-sign envelope the signed-in client was a
// signer on (portalGuard, documents section). Signing itself stays with the
// e-sign vendor's emailed link.

import { portalError, portalGuard, pdfResponse } from "@/lib/portal/http";
import { portalSignedPdf } from "@/lib/portal/data";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const p = await portalGuard(req, { section: "documents" });
  if (p instanceof Response) return p;
  try {
    const { pdf, filename } = await portalSignedPdf(p, (await params).id);
    return pdfResponse(pdf, filename);
  } catch (err) {
    return portalError(err);
  }
}
