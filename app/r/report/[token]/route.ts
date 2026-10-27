// ShapesOS — public report share (Phase 23). NO auth.
// GET /r/report/[token] — token-guarded read of one shared report PDF.
// Unknown, expired, and revoked tokens all 404 identically (no oracle).
// Exposes only the PDF bytes (inline) — never the workspace, template
// internals, or client record.

import { readStoredRef } from "@/lib/filesystem/storage";
import { recordReportShareOpen, resolveReportShareToken } from "@/lib/sharing/doc-shares";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const resolved = await resolveReportShareToken(token);
  if (!resolved) return new Response("Not found", { status: 404 });
  const { report } = resolved;

  const bytes = await readStoredRef(report.pdfPath!, "reports").catch(() => null);
  if (!bytes) return new Response("Not found", { status: 404 });
  void recordReportShareOpen(resolved.share);

  const filename = `${(report.templateName ?? "report").replace(/[^a-z0-9-_]+/gi, "-")}-${report.period}.pdf`;
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${filename}"`,
      "Content-Length": String(bytes.length),
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}
