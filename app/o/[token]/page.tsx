// ShapesOS — public Office-doc share page (Phase 23). NO auth.
// GET /o/[token] — token-guarded read-only preview of one shared doc.
// Unknown, expired, and revoked tokens all 404 identically (no oracle).
// Exposes only: the doc's title, kind, content (read-only) and last-updated
// time. Never: workspace name, members, or anything else in the workspace.

import { notFound } from "next/navigation";
import nextDynamic from "next/dynamic";
import { FileText } from "lucide-react";
import { recordDocShareOpen, resolveDocShareToken } from "@/lib/sharing/doc-shares";

export const dynamic = "force-dynamic";

const SharedDocEmbed = nextDynamic(() => import("@/components/office/SharedDocEmbed"), {
  ssr: false,
  loading: () => (
    <div className="flex h-[560px] items-center justify-center rounded-lg bg-paper shadow-hairline">
      <span className="text-sm text-muted">Loading…</span>
    </div>
  ),
});

export async function generateMetadata() {
  return { title: "Shared document — ShapesOS", robots: { index: false, follow: false } };
}

const KIND_LABEL: Record<string, string> = {
  sheet: "Spreadsheet",
  doc: "Document",
  slide: "Slides",
};

export default async function SharedDocPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const resolved = await resolveDocShareToken(token);
  if (!resolved) notFound();
  void recordDocShareOpen(resolved.share);
  const { doc } = resolved;

  return (
    <main className="mx-auto flex min-h-dvh max-w-5xl flex-col gap-4 px-4 py-8">
      <header className="flex items-center gap-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-paper shadow-hairline">
          <FileText size={16} aria-hidden />
        </span>
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold text-ink">{doc.title}</h1>
          <p className="text-xs text-muted">
            {KIND_LABEL[doc.kind] ?? "Document"} · shared read-only · updated{" "}
            {doc.updatedAt.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
          </p>
        </div>
      </header>
      <SharedDocEmbed kind={doc.kind} snapshot={doc.snapshot} />
      <footer className="text-center text-xs text-subtle">
        Shared via ShapesOS. This is a read-only link; it can be revoked at any time.
      </footer>
    </main>
  );
}
