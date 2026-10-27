// Marketr — Phase 14: Office client (docs list + embedded editor).
// House pattern: dense table with badge columns, brand-var buttons, Lucide.

"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import {
  FileSpreadsheet,
  FileText,
  Presentation,
  Plus,
  Trash2,
  Loader2,
  ArrowLeft,
  Download,
  Share2,
} from "lucide-react";
import { confirmAction } from "@/lib/ui/feedback";
import ShareLinksPanel from "@/components/sharing/ShareLinksPanel";

const UniverEmbed = dynamic(() => import("@/components/office/UniverEmbed"), {
  ssr: false,
  loading: () => (
    <div className="flex h-[560px] items-center justify-center rounded-lg bg-paper shadow-hairline">
      <Loader2 className="h-6 w-6 animate-spin text-subtle" />
    </div>
  ),
});

interface DocSummary {
  id: string;
  kind: string;
  title: string;
  version: number;
  sourceRef: string | null;
  shareState: string;
  createdAt: string;
  updatedAt: string;
}

interface FullDoc extends DocSummary {
  snapshot: unknown;
}

// Document kinds are categories, not agent states — neutrals only.
const KIND_META: Record<string, { label: string; icon: typeof FileSpreadsheet }> = {
  sheet: { label: "Sheet", icon: FileSpreadsheet },
  doc: { label: "Doc", icon: FileText },
  slide: { label: "Deck", icon: Presentation },
};

const kindBadge =
  "inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-paper px-2 py-0.5 text-xs font-semibold text-muted shadow-control";

const btnPrimary =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-ink px-4 text-sm font-semibold text-white aos-press hover:bg-ink-hover disabled:opacity-50";
const btnSecondary =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-paper px-4 text-sm font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper";

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export function OfficeClient({ initialDocs, openId }: { initialDocs: DocSummary[]; openId?: string }) {
  const [docs, setDocs] = useState<DocSummary[]>(initialDocs);
  const [openDoc, setOpenDoc] = useState<FullDoc | null>(null);
  const [showShare, setShowShare] = useState(false);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const autoOpened = useRef(false);

  const flash = (kind: "ok" | "err", text: string) => {
    setNotice({ kind, text });
    window.setTimeout(() => setNotice(null), 5000);
  };

  async function refresh() {
    const res = await fetch("/api/office/docs");
    if (res.ok) {
      const data = await res.json();
      setDocs(data.docs ?? []);
    }
  }

  async function createDoc(kind: string) {
    setCreating(kind);
    try {
      const res = await fetch("/api/office/docs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind,
          title: kind === "sheet" ? "Untitled sheet" : kind === "doc" ? "Untitled document" : "Untitled deck",
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      await refresh();
      flash("ok", "Created.");
    } catch (e) {
      flash("err", e instanceof Error ? e.message : "Create failed.");
    } finally {
      setCreating(null);
    }
  }

  async function open(id: string) {
    setLoading(true);
    try {
      const res = await fetch(`/api/office/docs/${id}`);
      if (!res.ok) throw new Error("Not found.");
      const data = await res.json();
      setOpenDoc(data.doc);
    } catch (e) {
      flash("err", e instanceof Error ? e.message : "Open failed.");
    } finally {
      setLoading(false);
    }
  }

  // Deep link: /dashboard/office?open=<id> (from "Open as sheet" buttons).
  useEffect(() => {
    if (!autoOpened.current && openId) {
      autoOpened.current = true;
      void open(openId);
    }
    // open is stable (no deps); run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSave(snapshot: unknown) {
    if (!openDoc) return;
    const res = await fetch(`/api/office/docs/${openDoc.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ snapshot, expectedVersion: openDoc.version }),
    });
    if (res.status === 409) {
      flash("err", "Someone else saved a newer version — reload the doc and re-apply your edits.");
      return;
    }
    if (!res.ok) {
      flash("err", "Save failed.");
      return;
    }
    const data = await res.json();
    setOpenDoc(data.doc);
    await refresh();
    flash("ok", `Saved (v${data.doc.version}).`);
  }

  async function remove(id: string, title: string) {
    if (!await confirmAction(`Delete "${title}"? This cannot be undone.`)) return;
    const res = await fetch(`/api/office/docs/${id}`, { method: "DELETE" });
    if (!res.ok) {
      flash("err", "Delete failed.");
      return;
    }
    if (openDoc?.id === id) setOpenDoc(null);
    await refresh();
    flash("ok", "Deleted.");
  }

  if (openDoc) {
    const meta = KIND_META[openDoc.kind] ?? KIND_META.sheet;
    const editable = openDoc.kind === "sheet" || openDoc.kind === "doc" || openDoc.kind === "slide";
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={() => setOpenDoc(null)}
            className="inline-flex items-center gap-1.5 rounded-full px-3 py-2 text-sm font-medium text-muted hover:bg-hover-paper hover:text-ink"
          >
            <ArrowLeft className="h-4 w-4" /> All docs
          </button>
          <div className="flex items-center gap-2">
            {openDoc.kind === "sheet" ? (
              <>
                <a
                  href={`/api/office/docs/${openDoc.id}/export?format=csv`}
                  className={btnSecondary}
                >
                  <Download className="h-4 w-4" />
                  Export CSV
                </a>
                {/* Phase 11 (seotools): Excel export, every tab */}
                <a
                  href={`/api/office/docs/${openDoc.id}/export?format=xlsx`}
                  className={btnSecondary}
                >
                  <Download className="h-4 w-4" />
                  Export Excel
                </a>
              </>
            ) : openDoc.kind === "doc" ? (
              <>
                <a
                  href={`/api/office/docs/${openDoc.id}/export?format=pdf`}
                  className={btnSecondary}
                >
                  <Download className="h-4 w-4" />
                  Export PDF
                </a>
                {/* Phase 11 (seotools): Word export */}
                <a
                  href={`/api/office/docs/${openDoc.id}/export?format=docx`}
                  className={btnSecondary}
                >
                  <Download className="h-4 w-4" />
                  Export Word
                </a>
              </>
            ) : null}
            <button
              type="button"
              onClick={() => setShowShare((v) => !v)}
              className={btnSecondary}
              title="Share a read-only link to this doc"
            >
              <Share2 className="h-4 w-4" />
              Share
            </button>
            <span className={kindBadge}>
              <meta.icon className="h-3 w-3" /> {meta.label} · v{openDoc.version}
            </span>
          </div>
        </div>
        <h2 className="aos-subheading">{openDoc.title}</h2>
        {showShare ? (
          <ShareLinksPanel
            endpoint={`/api/office/docs/${openDoc.id}/shares`}
            subjectLabel="document"
            publicPath={(token) => `/o/${token}`}
          />
        ) : null}
        {editable ? (
          <UniverEmbed
            key={openDoc.id}
            kind={openDoc.kind as "sheet" | "doc" | "slide"}
            snapshot={openDoc.snapshot}
            onSave={handleSave}
          />
        ) : (
          <UniverEmbed
            key={openDoc.id}
            kind="slide"
            snapshot={openDoc.snapshot as unknown as Record<string, unknown>}
            height={560}
            onSave={handleSave}
          />
        )}
        {notice && (
          <p className={`text-sm ${notice.kind === "ok" ? "text-muted" : "text-failed-text"}`}>
            {notice.text}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted">
          {docs.length} doc{docs.length === 1 ? "" : "s"} — snapshots stored by ShapesOS, never in a third-party cloud.
        </p>
        <div className="flex items-center gap-2">
          {(["sheet", "doc"] as const).map((kind) => (
            <button
              key={kind}
              type="button"
              onClick={() => createDoc(kind)}
              disabled={creating !== null}
              className={btnPrimary}
            >
              {creating === kind ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Plus className="h-3.5 w-3.5" />
              )}
              New {kind === "sheet" ? "sheet" : "doc"}
            </button>
          ))}
        </div>
      </div>

      {notice && (
        <p className={`text-sm ${notice.kind === "ok" ? "text-muted" : "text-failed-text"}`}>
          {notice.text}
        </p>
      )}

      <div className="overflow-hidden rounded-lg bg-paper shadow-hairline">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-line text-xs font-semibold text-muted">
              <th className="px-3 py-2 font-medium">Title</th>
              <th className="px-3 py-2 font-medium">Kind</th>
              <th className="px-3 py-2 font-medium">Source</th>
              <th className="px-3 py-2 font-medium">Updated</th>
              <th className="px-3 py-2 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {docs.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-sm text-subtle">
                  No docs yet — create a sheet or doc to get started.
                </td>
              </tr>
            )}
            {docs.map((d) => {
              const meta = KIND_META[d.kind] ?? KIND_META.sheet;
              return (
                <tr key={d.id} className="border-b border-line last:border-0 hover:bg-hover-paper">
                  <td className="px-3 py-2">
                    <button
                      type="button"
                      onClick={() => open(d.id)}
                      disabled={loading}
                      className="font-medium text-ink hover:underline"
                    >
                      {d.title}
                    </button>
                    <span className="ml-2 text-xs text-subtle">v{d.version}</span>
                  </td>
                  <td className="px-3 py-2">
                    <span className={kindBadge}>
                      <meta.icon className="h-3 w-3" /> {meta.label}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-muted">{d.sourceRef ?? "—"}</td>
                  <td className="px-3 py-2 text-muted">{fmtDate(d.updatedAt)}</td>
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => remove(d.id, d.title)}
                      className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold text-failed-text hover:bg-failed-tint"
                    >
                      <Trash2 className="h-3.5 w-3.5" /> Delete
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
