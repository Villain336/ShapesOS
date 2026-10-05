// ShapesOS — Phase 10 (portal): GET /api/portal/quotes/[id]/pdf — the finance
// quote PDF for a sent/decided quote linked to the signed-in client
// (portalGuard, quotes section). 404 otherwise.

import { portalError, portalGuard, pdfResponse } from "@/lib/portal/http";
import { portalQuotePdf } from "@/lib/portal/data";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const p = await portalGuard(req, { section: "quotes" });
  if (p instanceof Response) return p;
  try {
    const { pdf, filename } = await portalQuotePdf(p, (await params).id);
    return pdfResponse(pdf, filename);
  } catch (err) {
    return portalError(err);
  }
}
