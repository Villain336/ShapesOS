// ShapesOS — public report share bytes (Phase 23). NO auth.
// GET /r/report/[token]/raw — streams the shared report PDF (inline) for
// the viewer page. Unknown, expired, and revoked tokens all 404
// identically (no oracle).

import { readStoredRef } from "@/lib/filesystem/storage";
import { resolveReportShareToken } from "@/lib/sharing/doc-shares";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const resolved = await resolveReportShareToken(token);
  if (!resolved) return new Response("Not found", { status: 404 });
  const { report } = resolved;

  const bytes = await readStoredRef(report.pdfPath!, "reports").catch(() => null);
  if (!bytes) return new Response("Not found", { status: 404 });

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
