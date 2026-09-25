// Marketr — EDDM concierge API: brief PDF download.
// GET /api/eddm/orders/[id]/brief-pdf → the stored handoff brief PDF.

import { promises as fs } from "node:fs";
import path from "node:path";
import {
  guardWorkspace,
  httpErrorResponse,
} from "@/lib/enrichment/guard";
import { getEddmOrder } from "@/lib/mail/eddm";
import { eddmBriefStorageDir } from "@/lib/mail/eddm-brief";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  try {
    const { workspace } = await guardWorkspace();
    const { id } = await params;
    const order = await getEddmOrder(workspace.id, id);
    if (!order || !order.briefPdfUrl) {
      return Response.json({ error: "No brief generated for this order yet." }, { status: 404 });
    }
    const pdfPath = path.join(eddmBriefStorageDir(), `${order.id}.pdf`);
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(pdfPath);
    } catch {
      return Response.json({ error: "Brief file missing from disk." }, { status: 404 });
    }
    const filename = `eddm-brief-${order.name.replace(/[^a-z0-9]+/gi, "-").slice(0, 40) || "order"}.pdf`;
    return new Response(new Uint8Array(bytes), {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
