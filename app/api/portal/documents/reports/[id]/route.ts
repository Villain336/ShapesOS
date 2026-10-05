// ShapesOS — Phase 10 (portal): GET /api/portal/documents/reports/[id] — a
// white-label report PDF assigned to the signed-in client (Report.clientId),
// served from report storage (portalGuard, documents section).

import { portalError, portalGuard, pdfResponse } from "@/lib/portal/http";
import { portalReportPdf } from "@/lib/portal/data";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const p = await portalGuard(req, { section: "documents" });
  if (p instanceof Response) return p;
  try {
    const { pdf, filename } = await portalReportPdf(p, (await params).id);
    return pdfResponse(pdf, filename);
  } catch (err) {
    return portalError(err);
  }
}
