// Marketr — Phase 14 slice 8: in-house doc export API.
// GET /api/office/docs/[id]/export?format=csv|pdf
//   csv → sheets only (RFC 4180), pdf → docs only (embedded PDF writer).
// No external services. Attachment download with a slugified filename.

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { getUniverDoc } from "@/lib/univer/docs";
import { exportDocPdf, exportSheetCsv, slugifyFilename } from "@/lib/univer/export";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { workspace } = await guardWorkspace();
    const { id } = await ctx.params;
    const format = new URL(req.url).searchParams.get("format");

    const doc = await getUniverDoc(workspace.id, id);
    if (!doc) return Response.json({ error: "not found" }, { status: 404 });

    if (format === "csv") {
      if (doc.kind !== "sheet") {
        return Response.json({ error: "CSV export is only available for sheets." }, { status: 400 });
      }
      const csv = exportSheetCsv(doc.snapshot as never);
      return new Response(csv, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${slugifyFilename(doc.title, "csv")}"`,
        },
      });
    }

    if (format === "pdf") {
      if (doc.kind !== "doc") {
        return Response.json({ error: "PDF export is only available for documents." }, { status: 400 });
      }
      const pdf = exportDocPdf(doc.snapshot as never, { title: doc.title });
      return new Response(pdf as unknown as BodyInit, {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="${slugifyFilename(doc.title, "pdf")}"`,
        },
      });
    }

    return Response.json({ error: "format must be csv or pdf" }, { status: 400 });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
