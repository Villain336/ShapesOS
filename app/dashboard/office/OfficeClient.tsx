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
} from "lucide-react";

const UniverEmbed = dynamic(() => import("@/components/office/UniverEmbed"), {
  ssr: false,
  loading: () => (
    <div className="flex h-[560px] items-center justify-center rounded-lg border border-stone-200 bg-white">
      <Loader2 className="h-6 w-6 animate-spin text-stone-400" />
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

const KIND_META: Record<string, { label: string; icon: typeof FileSpreadsheet; badge: string }> = {
  sheet: {
    label: "Sheet",
    icon: FileSpreadsheet,
    badge: "bg-emerald-50 text-emerald-700 border-emerald-200",
  },
  doc: {
    label: "Doc",
    icon: FileText,
    badge: "bg-sky-50 text-sky-700 border-sky-200",
  },
  slide: {
    label: "Deck",
    icon: Presentation,
    badge: "bg-amber-50 text-amber-700 border-amber-200",
  },
};

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
    if (!window.confirm(`Delete "${title}"? This cannot be undone.`)) return;
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
    const editable = openDoc.kind === "sheet" || openDoc.kind === "doc";
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={() => setOpenDoc(null)}
            className="inline-flex items-center gap-1.5 text-[13px] font-medium text-stone-600 hover:text-stone-900"
          >
            <ArrowLeft className="h-4 w-4" /> All docs
          </button>
          <div className="flex items-center gap-2">
            <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${meta.badge}`}>
              <meta.icon className="h-3 w-3" /> {meta.label} · v{openDoc.version}
            </span>
          </div>
        </div>
        <h2 className="text-lg font-bold tracking-tight text-stone-900">{openDoc.title}</h2>
        {editable ? (
          <UniverEmbed
            key={openDoc.id}
            kind={openDoc.kind as "sheet" | "doc"}
            snapshot={openDoc.snapshot}
            onSave={handleSave}
          />
        ) : (
          <div className="rounded-lg border border-stone-200 bg-white p-8 text-center">
            <Presentation className="mx-auto h-8 w-8 text-stone-300" />
            <p className="mt-2 text-[13px] text-stone-500">
              Deck editing lands with the slide surface (Phase 14 slice 9). The snapshot is
              stored and versioned.
            </p>
          </div>
        )}
        {notice && (
          <p className={`text-[13px] ${notice.kind === "ok" ? "text-emerald-700" : "text-red-700"}`}>
            {notice.text}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-[13px] text-stone-500">
          {docs.length} doc{docs.length === 1 ? "" : "s"} — snapshots stored by Marketr, never in a third-party cloud.
        </p>
        <div className="flex items-center gap-2">
          {(["sheet", "doc"] as const).map((kind) => (
            <button
              key={kind}
              type="button"
              onClick={() => createDoc(kind)}
              disabled={creating !== null}
              className="inline-flex items-center gap-1.5 rounded-md bg-[var(--brand-600)] px-3 py-1.5 text-[13px] font-medium text-white hover:bg-[var(--brand-700)] disabled:opacity-50"
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
        <p className={`text-[13px] ${notice.kind === "ok" ? "text-emerald-700" : "text-red-700"}`}>
          {notice.text}
        </p>
      )}

      <div className="overflow-hidden rounded-lg border border-stone-200 bg-white">
        <table className="w-full text-left text-[13px]">
          <thead>
            <tr className="border-b border-stone-200 bg-stone-50 text-stone-500">
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
                <td colSpan={5} className="px-3 py-8 text-center text-stone-400">
                  No docs yet — create a sheet or doc to get started.
                </td>
              </tr>
            )}
            {docs.map((d) => {
              const meta = KIND_META[d.kind] ?? KIND_META.sheet;
              return (
                <tr key={d.id} className="border-b border-stone-100 last:border-0 hover:bg-[var(--brand-50)]/40">
                  <td className="px-3 py-2">
                    <button
                      type="button"
                      onClick={() => open(d.id)}
                      disabled={loading}
                      className="font-medium text-stone-900 hover:text-[var(--brand-700)] hover:underline"
                    >
                      {d.title}
                    </button>
                    <span className="ml-2 text-xs text-stone-400">v{d.version}</span>
                  </td>
                  <td className="px-3 py-2">
                    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${meta.badge}`}>
                      <meta.icon className="h-3 w-3" /> {meta.label}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-stone-500">{d.sourceRef ?? "—"}</td>
                  <td className="px-3 py-2 text-stone-500">{fmtDate(d.updatedAt)}</td>
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => remove(d.id, d.title)}
                      className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-stone-500 hover:bg-red-50 hover:text-red-700"
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
