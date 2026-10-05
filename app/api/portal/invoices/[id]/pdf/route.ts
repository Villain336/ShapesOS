// ShapesOS — Phase 10 (portal): GET /api/portal/invoices/[id]/pdf — the
// finance invoice PDF (lib/ops/finance/pdf.tsx) for an issued invoice linked
// to the signed-in client (portalGuard, invoices section). 404 otherwise.

import { portalError, portalGuard, pdfResponse } from "@/lib/portal/http";
import { portalInvoicePdf } from "@/lib/portal/data";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const p = await portalGuard(req, { section: "invoices" });
  if (p instanceof Response) return p;
  try {
    const { pdf, filename } = await portalInvoicePdf(p, (await params).id);
    return pdfResponse(pdf, filename);
  } catch (err) {
    return portalError(err);
  }
}
