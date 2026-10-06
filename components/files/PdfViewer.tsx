"use client";

// ShapesOS — Phase 18.2 (WS=content): PDF preview with pdf.js (pdfjs-dist,
// loaded only here, on demand — never in a server bundle). One page at a
// time on a canvas, with pdf.js's text layer on top so text can be selected;
// a selection can become a highlight or a comment (stored per file version by
// /api/files/[id]/annotations — never written into the PDF).
//
// The worker is bundled as a same-origin module worker
// (new Worker(new URL(…, import.meta.url))), so the page CSP's
// worker-src 'self' allows it; nothing is loaded from a CDN.
// Highlights are neutral ink washes, never yellow: yellow means "Needs you"
// (DESIGN.md).

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Highlighter, MessageSquare, Trash2, ZoomIn, ZoomOut } from "lucide-react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { aosButton } from "@/components/aos";
import { useI18n } from "@/components/i18n/I18nProvider";
import "./pdf-viewer.css";

export interface PdfRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PdfAnnotation {
  id: string;
  page: number;
  kind: "highlight" | "comment";
  rects: PdfRect[];
  quote: string | null;
  body: string | null;
  canEdit: boolean;
}

export interface NewPdfAnnotation {
  page: number;
  kind: "highlight" | "comment";
  rects: PdfRect[];
  quote: string;
  body?: string;
}

type PdfjsModule = typeof import("pdfjs-dist");
let pdfjsPromise: Promise<PdfjsModule> | null = null;

function loadPdfjs(): Promise<PdfjsModule> {
  pdfjsPromise ??= import("pdfjs-dist").then((m) => {
    if (!m.GlobalWorkerOptions.workerPort) {
      m.GlobalWorkerOptions.workerPort = new Worker(new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url), { type: "module" });
    }
    return m;
  });
  return pdfjsPromise;
}

export function PdfViewer({
  src,
  annotations = [],
  canAnnotate = false,
  onCreate,
  onRemove,
  initialPage = 1,
}: {
  src: string;
  annotations?: PdfAnnotation[];
  canAnnotate?: boolean;
  onCreate?: (a: NewPdfAnnotation) => Promise<void>;
  onRemove?: (id: string) => Promise<void>;
  initialPage?: number;
}) {
  const { t } = useI18n();
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(initialPage);
  const [zoom, setZoom] = useState(1);
  const [width, setWidth] = useState(0);
  const [pending, setPending] = useState<{ rects: PdfRect[]; quote: string; top: number; left: number } | null>(null);
  const [commenting, setCommenting] = useState(false);
  const [comment, setComment] = useState("");
  const holder = useRef<HTMLDivElement>(null);
  const pageBox = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const textLayer = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    let task: { destroy(): Promise<void> } | null = null;
    setDoc(null);
    setError(null);
    void loadPdfjs()
      .then((pdfjs) => {
        const t = pdfjs.getDocument({ url: src });
        task = t;
        return t.promise;
      })
      .then((d) => {
        if (!cancelled) setDoc(d);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
      void task?.destroy();
    };
  }, [src]);

  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.floor(entry!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!doc || !width || !canvas.current || !textLayer.current || !pageBox.current) return;
    let task: RenderTask | null = null;
    let cancelled = false;
    void (async () => {
      const pdfjs = await loadPdfjs();
      const p = await doc.getPage(Math.min(Math.max(page, 1), doc.numPages));
      if (cancelled) return;
      const base = p.getViewport({ scale: 1 });
      const scale = Math.min(2.5, Math.max(0.3, ((width - 2) / base.width) * zoom));
      const viewport = p.getViewport({ scale });
      const ratio = window.devicePixelRatio || 1;
      const c = canvas.current!;
      c.width = Math.floor(viewport.width * ratio);
      c.height = Math.floor(viewport.height * ratio);
      c.style.width = `${Math.floor(viewport.width)}px`;
      c.style.height = `${Math.floor(viewport.height)}px`;
      const box = pageBox.current!;
      box.style.width = `${Math.floor(viewport.width)}px`;
      box.style.height = `${Math.floor(viewport.height)}px`;
      box.style.setProperty("--total-scale-factor", String(scale));
      task = p.render({ canvas: c, viewport, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined });
      await task.promise.catch(() => undefined);
      if (cancelled) return;
      const tl = textLayer.current!;
      tl.replaceChildren();
      await new pdfjs.TextLayer({ textContentSource: p.streamTextContent(), container: tl, viewport }).render().catch(() => undefined);
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, page, width, zoom]);

  const onMouseUp = useCallback(() => {
    if (!canAnnotate || !pageBox.current) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const box = pageBox.current.getBoundingClientRect();
    const rects: PdfRect[] = [];
    for (let i = 0; i < sel.rangeCount; i++) {
      for (const r of Array.from(sel.getRangeAt(i).getClientRects())) {
        if (r.width < 1 || r.height < 1) continue;
        if (r.right < box.left || r.left > box.right || r.bottom < box.top || r.top > box.bottom) continue;
        rects.push({ x: (r.left - box.left) / box.width, y: (r.top - box.top) / box.height, w: r.width / box.width, h: r.height / box.height });
      }
    }
    const quote = sel.toString().trim();
    if (!rects.length || !quote) return;
    const last = rects[rects.length - 1]!;
    setPending({ rects: rects.slice(0, 64), quote: quote.slice(0, 2000), top: (last.y + last.h) * box.height + 6, left: Math.min(last.x * box.width, box.width - 220) });
    setCommenting(false);
    setComment("");
  }, [canAnnotate]);

  async function save(kind: "highlight" | "comment") {
    if (!pending || !onCreate) return;
    if (kind === "comment" && !comment.trim()) return;
    await onCreate({ page, kind, rects: pending.rects, quote: pending.quote, ...(kind === "comment" ? { body: comment.trim() } : {}) });
    window.getSelection()?.removeAllRanges();
    setPending(null);
    setCommenting(false);
  }

  const onPage = annotations.filter((a) => a.page === page);
  const pages = doc?.numPages ?? 0;

  if (error) {
    return (
      <p role="alert" className="flex items-center gap-2 py-6 text-sm font-semibold text-failed-text">
        <span aria-hidden className="size-2 shrink-0 bg-failed" />
        {t("filesApp.preview.pdfFailed")}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label={t("filesApp.preview.pdfToolbar")}>
        <button type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className={aosButton({ variant: "secondary", size: "xs", className: "w-8 px-0" })} aria-label={t("filesApp.preview.prevPage")}>
          <ChevronLeft className="size-4" aria-hidden />
        </button>
        <span className="text-sm tabular-nums text-muted" aria-live="polite">
          {doc ? t("filesApp.preview.pageOf", { page, pages }) : t("common.loading")}
        </span>
        <button type="button" disabled={!doc || page >= pages} onClick={() => setPage((p) => p + 1)} className={aosButton({ variant: "secondary", size: "xs", className: "w-8 px-0" })} aria-label={t("filesApp.preview.nextPage")}>
          <ChevronRight className="size-4" aria-hidden />
        </button>
        <span className="ml-auto flex items-center gap-1">
          <button type="button" onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.25).toFixed(2)))} className={aosButton({ variant: "quiet", size: "xs", className: "w-8 px-0" })} aria-label={t("filesApp.preview.zoomOut")}>
            <ZoomOut className="size-4" aria-hidden />
          </button>
          <span className="w-12 text-center text-xs tabular-nums text-muted">{Math.round(zoom * 100)}%</span>
          <button type="button" onClick={() => setZoom((z) => Math.min(2, +(z + 0.25).toFixed(2)))} className={aosButton({ variant: "quiet", size: "xs", className: "w-8 px-0" })} aria-label={t("filesApp.preview.zoomIn")}>
            <ZoomIn className="size-4" aria-hidden />
          </button>
        </span>
      </div>
      {canAnnotate ? <p className="text-xs text-subtle">{t("filesApp.preview.selectHint")}</p> : null}
      <div ref={holder} className="w-full overflow-auto rounded-md bg-canvas p-1">
        <div ref={pageBox} className="pdf-page relative mx-auto bg-paper shadow-hairline" style={{ ["--scale-round-x" as string]: "1px", ["--scale-round-y" as string]: "1px" }} onMouseUp={onMouseUp}>
          <canvas ref={canvas} aria-label={t("filesApp.preview.pageImage", { page })} role="img" />
          <div ref={textLayer} className="textLayer" />
          {onPage.map((a) =>
            a.rects.map((r, i) => (
              <span
                key={`${a.id}:${i}`}
                aria-hidden
                title={a.body ?? a.quote ?? undefined}
                className={`pointer-events-none absolute z-[2] ${a.kind === "comment" ? "border-b-2 border-ink bg-ink/10" : "bg-ink/15"}`}
                style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` }}
              />
            )),
          )}
          {pending ? (
            <div className="absolute z-10 flex w-[220px] flex-col gap-2 rounded-lg bg-paper p-2 shadow-raised" style={{ top: pending.top, left: Math.max(0, pending.left) }}>
              {commenting ? (
                <>
                  <label className="sr-only" htmlFor="pdf-comment">
                    {t("filesApp.preview.commentLabel")}
                  </label>
                  <textarea
                    id="pdf-comment"
                    autoFocus
                    rows={3}
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    className="w-full rounded-md border-[1.5px] border-control bg-paper px-2 py-1.5 text-sm text-ink outline-none focus:border-focus"
                  />
                  <div className="flex justify-end gap-1">
                    <button type="button" onClick={() => setPending(null)} className={aosButton({ variant: "quiet", size: "xs" })}>
                      {t("common.cancel")}
                    </button>
                    <button type="button" disabled={!comment.trim()} onClick={() => void save("comment")} className={aosButton({ size: "xs" })}>
                      {t("filesApp.preview.addComment")}
                    </button>
                  </div>
                </>
              ) : (
                <div className="flex gap-1">
                  <button type="button" onClick={() => void save("highlight")} className={aosButton({ size: "xs" })}>
                    <Highlighter className="size-3.5" aria-hidden />
                    {t("filesApp.preview.highlight")}
                  </button>
                  <button type="button" onClick={() => setCommenting(true)} className={aosButton({ variant: "secondary", size: "xs" })}>
                    <MessageSquare className="size-3.5" aria-hidden />
                    {t("filesApp.preview.comment")}
                  </button>
                </div>
              )}
            </div>
          ) : null}
        </div>
      </div>
      {annotations.length ? (
        <section aria-label={t("filesApp.preview.annotationsLabel")} className="flex flex-col gap-1">
          <h3 className="text-sm font-semibold text-ink">{t("filesApp.preview.annotationsTitle", { count: annotations.length })}</h3>
          <ul className="flex flex-col">
            {annotations.map((a) => (
              <li key={a.id} className="flex items-start gap-2 border-b border-line py-2 last:border-0">
                <button type="button" onClick={() => setPage(a.page)} className="min-w-0 flex-1 text-left hover:underline">
                  <span className="block text-xs text-subtle">
                    {t("filesApp.preview.onPage", { page: a.page })} · {a.kind === "comment" ? t("filesApp.preview.comment") : t("filesApp.preview.highlight")}
                  </span>
                  {a.quote ? <span className="block truncate text-sm text-muted">“{a.quote}”</span> : null}
                  {a.body ? <span className="block text-sm text-ink">{a.body}</span> : null}
                </button>
                {a.canEdit && onRemove ? (
                  <button type="button" onClick={() => void onRemove(a.id)} className="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-muted hover:bg-hover" aria-label={t("filesApp.preview.removeAnnotation")}>
                    <Trash2 className="size-4" aria-hidden />
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

export default PdfViewer;
