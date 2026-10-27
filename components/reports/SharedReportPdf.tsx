"use client";

// ShapesOS — read-only PDF mount for a publicly shared report (Phase 23).
// Loads the house pdf.js viewer on demand; canAnnotate stays false: the
// public page has no write route behind it.

import dynamic from "next/dynamic";

const PdfViewer = dynamic(
  () => import("@/components/files/PdfViewer").then((m) => m.PdfViewer),
  { ssr: false, loading: () => <div className="flex h-[560px] items-center justify-center rounded-lg bg-paper shadow-hairline"><span className="text-sm text-muted">Loading…</span></div> },
);

export default function SharedReportPdf({ src }: { src: string }) {
  return <PdfViewer src={src} />;
}
