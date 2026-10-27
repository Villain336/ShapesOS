// ShapesOS — public report share (Phase 23). NO auth.
// GET /r/report/[token] — token-guarded read-only viewer for one shared
// report PDF; the bytes stream from ./raw. Unknown, expired, and revoked
// tokens all 404 identically (no oracle). Exposes only the PDF and its
// template name + period — never the workspace or the client record.

import { notFound } from "next/navigation";
import { FileText } from "lucide-react";
import { recordReportShareOpen, resolveReportShareToken } from "@/lib/sharing/doc-shares";
import SharedReportPdf from "@/components/reports/SharedReportPdf";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  return { title: "Shared report — ShapesOS", robots: { index: false, follow: false } };
}

export default async function SharedReportPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const resolved = await resolveReportShareToken(token);
  if (!resolved) notFound();
  void recordReportShareOpen(resolved.share);
  const { report } = resolved;
  const raw = `/r/report/${encodeURIComponent(token)}/raw`;

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <header className="mb-6 flex items-start gap-3">
        <span className="mt-0.5 text-muted"><FileText size={20} /></span>
        <div>
          <h1 className="text-xl font-semibold text-ink">{report.templateName ?? "Report"}</h1>
          <p className="mt-1 text-sm text-muted">
            {report.period} · shared read-only via ShapesOS
          </p>
        </div>
      </header>
      <SharedReportPdf src={raw} />
    </main>
  );
}
