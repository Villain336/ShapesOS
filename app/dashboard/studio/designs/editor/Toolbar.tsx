// Marketr — Phase 11 "Canvas": contextual toolbar. No selection → page
// controls; text selected → typography; any selection → opacity, lock,
// z-order, align, duplicate, delete. Right side: undo/redo, export, save state.

"use client";

import { useEffect, useRef, useState } from "react";
import {
  AlignCenter,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalDistributeCenter,
  AlignLeft,
  AlignRight,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalDistributeCenter,
  ArrowDownToLine,
  ArrowUpFromLine,
  Bold,
  Check,
  ChevronDown,
  Copy,
  Download,
  Eraser,
  History,
  Italic,
  Loader2,
  Lock,
  Plus,
  Redo,
  Scaling,
  Share2,
  Trash2,
  Undo,
  Unlock,
  Wand2,
  X,
} from "lucide-react";
import { useCanvasStore, type AlignEdge } from "@/lib/design/store";
import type { ChartElement, DesignElement, ImageElement, QrElement, TextElement } from "@/lib/design/types";
import type { StageRef } from "./DesignCanvas";
import { removeImageBackground } from "@/lib/design/background-removal";
import { AI_DESIGN_SIZES } from "@/lib/design/ai";
import { btnGhost, iconBtn, iconBtnActive, inputCls } from "./ui";
import { BatchModal } from "./BatchModal";
import { ChartDataEditor } from "./ChartDataEditor";
import { FontPicker } from "./FontPicker";
import { QrEditor } from "./QrEditor";
import { ShareModal } from "./ShareModal";
import { awaitFontsReady, ensureFontLoaded } from "@/lib/design/fonts";

export type SaveState = "idle" | "saving" | "saved" | "error";

interface ToolbarProps {
  stageRef: StageRef;
  designId: string;
  designName: string;
  onNameChange: (name: string) => void;
  saveState: SaveState;
  brandFonts: string[];
}

function isText(el: DesignElement): el is TextElement {
  return el.type === "text";
}

function fillablePatch(el: DesignElement, color: string): Record<string, unknown> {
  if (el.type === "line") return { stroke: color };
  if (el.type === "image") return {};
  if (el.type === "chart") return { colors: [color] };
  if (el.type === "qr") return { foreground: color };
  return { fill: color };
}

/**
 * Background removal for a single selected image element. Non-destructive:
 * the original src is stashed in custom.originalSrc so the user can revert.
 * Runs 100% in the browser (WASM) — no key, no uploads leave the device.
 */
function BgRemovalControl({ el }: { el: ImageElement }) {
  const updateElement = useCanvasStore((s) => s.updateElement);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const originalSrc =
    el.custom && typeof el.custom.originalSrc === "string" ? el.custom.originalSrc : null;

  const remove = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setProgress("Loading engine…");
    try {
      const cutout = await removeImageBackground(el.src, (_label, done, total) => {
        const pct = total > 0 ? Math.round((done / total) * 100) : 0;
        setProgress(pct > 0 ? `Removing background… ${pct}%` : "Removing background…");
      });
      updateElement(el.id, {
        src: cutout,
        custom: { ...(el.custom ?? {}), originalSrc: el.src },
      });
      setProgress(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Background removal failed.");
      setProgress(null);
    } finally {
      setBusy(false);
    }
  };

  const restore = () => {
    if (!originalSrc) return;
    const { originalSrc: _dropped, ...rest } = (el.custom ?? {}) as Record<string, unknown>;
    updateElement(el.id, { src: originalSrc, custom: rest });
    setError(null);
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5" title="Background removal">
      {originalSrc ? (
        <button onClick={restore} disabled={busy} className={iconBtn} title="Restore original image">
          <History className="h-3.5 w-3.5" />
        </button>
      ) : (
        <button
          onClick={() => void remove()}
          disabled={busy}
          className={`${iconBtn} ${busy ? "" : "!w-auto !px-2.5 gap-1.5 text-[12px] font-medium"}`}
          title="Remove background (runs in your browser)"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Eraser className="h-3.5 w-3.5" />}
          {busy ? progress ?? "Working…" : "Remove background"}
        </button>
      )}
      {error && <span className="max-w-64 text-[11px] leading-snug text-failed-text">{error}</span>}
    </div>
  );
}

export function Toolbar({ stageRef, designId, designName, onNameChange, saveState, brandFonts }: ToolbarProps) {
  const doc = useCanvasStore((s) => s.document);
  const activePageId = useCanvasStore((s) => s.activePageId);
  const selectedIds = useCanvasStore((s) => s.selectedIds);
  const updateElement = useCanvasStore((s) => s.updateElement);
  const removeElements = useCanvasStore((s) => s.removeElements);
  const duplicateElements = useCanvasStore((s) => s.duplicateElements);
  const moveElement = useCanvasStore((s) => s.moveElement);
  const alignElements = useCanvasStore((s) => s.alignElements);
  const setPageBackground = useCanvasStore((s) => s.setPageBackground);
  const addPage = useCanvasStore((s) => s.addPage);
  const magicResize = useCanvasStore((s) => s.magicResize);
  const undo = useCanvasStore((s) => s.undo);
  const redo = useCanvasStore((s) => s.redo);
  const canUndo = useCanvasStore((s) => s.canUndo);
  const canRedo = useCanvasStore((s) => s.canRedo);

  const [exportOpen, setExportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [resizeOpen, setResizeOpen] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const exportRef = useRef<HTMLDivElement>(null);
  const resizeRef = useRef<HTMLDivElement>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (exportRef.current && !exportRef.current.contains(e.target as Node)) setExportOpen(false);
      if (resizeRef.current && !resizeRef.current.contains(e.target as Node)) setResizeOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  useEffect(() => {
    return () => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    };
  }, []);

  /** Run a magic resize on the current page and confirm with an undoable notice. */
  const doMagicResize = (preset: (typeof AI_DESIGN_SIZES)[number]) => {
    if (!page) return;
    const result = magicResize(page.id, preset.width, preset.height);
    setResizeOpen(false);
    if (!result) return;
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    const lockedNote =
      result.lockedCount > 0
        ? ` · ${result.lockedCount} locked element${result.lockedCount === 1 ? "" : "s"} resized`
        : "";
    setNotice(`Resized to ${preset.label} — undo available${lockedNote}`);
    noticeTimer.current = setTimeout(() => setNotice(null), 6000);
  };

  /** Batch generation finished: close the modal, confirm with an undoable notice. */
  const onBatchGenerated = (count: number) => {
    setBatchOpen(false);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    setNotice(
      `${count} variant page${count === 1 ? "" : "s"} added — review each one before exporting`,
    );
    noticeTimer.current = setTimeout(() => setNotice(null), 6000);
  };

  const page = doc?.pages.find((p) => p.id === activePageId) ?? null;
  const selected = (page?.elements ?? []).filter((el) => selectedIds.includes(el.id));
  const textEls = selected.filter(isText);
  const singleText = textEls.length === 1 && selected.length === 1 ? textEls[0]! : null;
  const allLocked = selected.length > 0 && selected.every((el) => el.locked);

  /**
   * Apply a picked family, then redraw once it is usable. Konva rasterizes
   * with whatever font is loaded at draw time, so without the post-load
   * batchDraw() a freshly-picked webfont would sit in a fallback face until
   * the next unrelated render.
   */
  const pickFont = (cssFamily: string) => {
    for (const t of textEls) updateElement(t.id, { fontFamily: cssFamily });
    void ensureFontLoaded(cssFamily).then(() => {
      stageRef.current?.getLayers().forEach((l) => l.batchDraw());
    });
  };

  const doExport = async (fmt: "png" | "jpg" | "pdf" | "svg") => {
    const stage = stageRef.current;
    if (!stage || !page || exporting) return;
    setExporting(true);
    let fontWarning: string[] = [];
    try {
      // Export gate (fonts.ts): canvas uses whatever is loaded AT DRAW TIME.
      // Await every family/weight/style the document uses before rasterizing,
      // otherwise text silently exports in a fallback font and the file lies.
      if (doc) {
        const gate = await awaitFontsReady(doc);
        fontWarning = gate.missing;
      }
      // Brief pause so in-flight images settle before capture.
      await new Promise((r) => setTimeout(r, 350));
      const base = (designName || "design").replace(/[^\w\- ]+/g, "").trim() || "design";
      if (fmt === "svg") {
        const { exportPageToSvg, svgFilename } = await import("@/lib/design/export-svg");
        // Pre-resolve remote image URLs to data URLs so the SVG is
        // self-contained. Failures fall back to the external href (the
        // serializer notes it with a warning comment).
        const imageSources: Record<string, string> = {};
        for (const el of page.elements) {
          if (el.type !== "image" || !el.visible) continue;
          if (el.src.startsWith("data:")) continue;
          try {
            const res = await fetch(el.src);
            if (!res.ok) continue;
            const blob = await res.blob();
            imageSources[el.id] = await new Promise<string>((resolve, reject) => {
              const fr = new FileReader();
              fr.onload = () => resolve(String(fr.result));
              fr.onerror = () => reject(new Error("readAsDataURL failed"));
              fr.readAsDataURL(blob);
            });
          } catch {
            // Keep the remote href; noted in the exported SVG.
          }
        }
        const res = exportPageToSvg(doc, page.id, { imageSources });
        if (!res.ok) throw new Error(res.error);
        const blob = new Blob([res.svg], { type: "image/svg+xml" });
        const url = URL.createObjectURL(blob);
        const a = window.document.createElement("a");
        a.href = url;
        a.download = svgFilename(base, page.name);
        a.click();
        URL.revokeObjectURL(url);
      } else if (fmt === "pdf") {
        // PRINT-GRADE PDF (CMYK / bleed / crop marks) is deliberately NOT
        // offered. jsPDF is RGB-only: it writes no ICC OutputIntent and no
        // DeviceCMYK color operators, so any "CMYK" export would be fake.
        // A real print pipeline would need: a vector path (this doc's SVG
        // serializer -> svg2pdf.js into jsPDF) + pdf-lib (or patched jsPDF)
        // to inject OutputIntents + an ICC profile, an RGB->CMYK conversion
        // pass over every fill, and bleed/crop-mark geometry with page boxes.
        // Until then, PDF export stays a rasterized RGB screen proof.
        const { jsPDF } = await import("jspdf");
        const dataUrl = stage.toDataURL({ pixelRatio: 2, mimeType: "image/png" });
        // 96dpi px → pt.
        const w = page.width * 0.75;
        const h = page.height * 0.75;
        const pdf = new jsPDF({ unit: "pt", format: [w, h], compress: true });
        pdf.addImage(dataUrl, "PNG", 0, 0, w, h);
        pdf.save(`${base}.pdf`);
      } else {
        const dataUrl = stage.toDataURL({
          pixelRatio: 2,
          mimeType: fmt === "jpg" ? "image/jpeg" : "image/png",
        });
        const a = window.document.createElement("a");
        a.href = dataUrl;
        a.download = `${base}.${fmt}`;
        a.click();
      }
      if (fontWarning.length > 0) {
        if (noticeTimer.current) clearTimeout(noticeTimer.current);
        setNotice(
          `Exported, but ${fontWarning.length === 1 ? "this font" : "these fonts"} could not be loaded — fallback used: ${fontWarning.join(", ")}`,
        );
        noticeTimer.current = setTimeout(() => setNotice(null), 8000);
      }
    } catch {
      // Export failed — leave the button usable.
    } finally {
      setExporting(false);
      setExportOpen(false);
    }
  };

  const toggleFontFlag = (flag: "bold" | "italic") => {
    for (const t of textEls) {
      const cur = t.fontStyle;
      let next: TextElement["fontStyle"];
      if (flag === "bold") {
        next = cur === "bold" ? "normal" : cur === "bold-italic" ? "italic" : cur === "italic" ? "bold-italic" : "bold";
      } else {
        next = cur === "italic" ? "normal" : cur === "bold-italic" ? "bold" : cur === "bold" ? "bold-italic" : "italic";
      }
      updateElement(t.id, { fontStyle: next });
    }
  };

  const zOrder = (dir: "front" | "back" | "forward" | "backward") => {
    const ids = dir === "front" ? [...selectedIds].reverse() : selectedIds;
    for (const id of ids) moveElement(id, dir);
  };

  const align: { edge: AlignEdge; icon: React.ReactNode; label: string }[] = [
    { edge: "left", icon: <AlignStartVertical className="h-3.5 w-3.5" />, label: "Align left" },
    { edge: "center-x", icon: <AlignVerticalDistributeCenter className="h-3.5 w-3.5" />, label: "Center horizontally" },
    { edge: "right", icon: <AlignEndVertical className="h-3.5 w-3.5" />, label: "Align right" },
    { edge: "top", icon: <AlignStartHorizontal className="h-3.5 w-3.5" />, label: "Align top" },
    { edge: "center-y", icon: <AlignHorizontalDistributeCenter className="h-3.5 w-3.5" />, label: "Center vertically" },
    { edge: "bottom", icon: <AlignEndHorizontal className="h-3.5 w-3.5" />, label: "Align bottom" },
  ];

  const saveLabel =
    saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved" : saveState === "error" ? "Save error" : "";

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-paper px-3 py-2">
      <input
        value={designName}
        onChange={(e) => onNameChange(e.target.value)}
        aria-label="Design name"
        className="w-44 rounded-md border border-transparent px-2 py-1 text-[13px] font-semibold text-ink hover:border-line focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)]"
      />

      <div className="h-5 w-px bg-line" />

      {selected.length === 0 && page && (
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-[12px] text-muted">
            <input
              type="color"
              value={page.background}
              onChange={(e) => setPageBackground(page.id, e.target.value)}
              className="h-7 w-8 cursor-pointer rounded border border-line bg-paper p-0.5"
              title="Page background"
            />
            Background
          </label>
          <span className="rounded bg-canvas px-1.5 py-0.5 font-mono text-[11px] text-muted">
            {page.width} × {page.height}
          </span>
          <div ref={resizeRef} className="relative">
            <button
              onClick={() => setResizeOpen((o) => !o)}
              className={`${btnGhost} !py-1 text-[12px]`}
              title="Magic resize — convert this page to another size"
            >
              <Scaling className="h-3.5 w-3.5 text-ink" />
              Magic resize
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
            {resizeOpen && (
              <div className="absolute left-0 z-30 mt-1 w-56 overflow-hidden rounded-md border border-line bg-paper shadow-overlay">
                <p className="px-3 pb-1 pt-2 text-[11px] font-semibold text-subtle">
                  Resize page to…
                </p>
                {AI_DESIGN_SIZES.map((preset) => {
                  const current = preset.width === page.width && preset.height === page.height;
                  return (
                    <button
                      key={preset.key}
                      disabled={current}
                      onClick={() => doMagicResize(preset)}
                      className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[13px] text-ink hover:bg-hover-paper disabled:cursor-default disabled:hover:bg-transparent"
                    >
                      <span className={current ? "text-subtle" : ""}>{preset.label}</span>
                      {current ? (
                        <span className="text-[11px] font-medium text-subtle">Current</span>
                      ) : (
                        <Scaling className="h-3.5 w-3.5 text-subtle" />
                      )}
                    </button>
                  );
                })}
                <p className="border-t border-line px-3 py-2 text-[11px] leading-snug text-subtle">
                  Layout scales proportionally. Locked elements resize too. Undo with Ctrl+Z.
                </p>
              </div>
            )}
          </div>
          <button onClick={addPage} className={iconBtn} title="Add page">
            <Plus className="h-4 w-4" />
          </button>
        </div>
      )}

      {textEls.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <FontPicker
            value={textEls[0]!.fontFamily}
            brandFonts={brandFonts}
            onChange={pickFont}
          />
          <input
            type="number"
            min={8}
            max={400}
            value={textEls[0]!.fontSize}
            onChange={(e) => {
              const v = Math.min(400, Math.max(8, parseInt(e.target.value, 10) || 8));
              for (const t of textEls) updateElement(t.id, { fontSize: v });
            }}
            className={`${inputCls} w-16 py-1 text-[12px]`}
            title="Font size"
          />
          <button
            onClick={() => toggleFontFlag("bold")}
            className={textEls.some((t) => t.fontStyle.includes("bold")) ? iconBtnActive : iconBtn}
            title="Bold"
          >
            <Bold className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => toggleFontFlag("italic")}
            className={textEls.some((t) => t.fontStyle.includes("italic")) ? iconBtnActive : iconBtn}
            title="Italic"
          >
            <Italic className="h-3.5 w-3.5" />
          </button>
          <input
            type="color"
            value={textEls[0]!.fill}
            onChange={(e) => {
              for (const t of textEls) updateElement(t.id, { fill: e.target.value });
            }}
            className="h-7 w-8 cursor-pointer rounded border border-line bg-paper p-0.5"
            title="Text color"
          />
          {(["left", "center", "right"] as const).map((a) => (
            <button
              key={a}
              onClick={() => {
                for (const t of textEls) updateElement(t.id, { align: a });
              }}
              className={textEls[0]!.align === a ? iconBtnActive : iconBtn}
              title={`Align ${a}`}
            >
              {a === "left" ? (
                <AlignLeft className="h-3.5 w-3.5" />
              ) : a === "center" ? (
                <AlignCenter className="h-3.5 w-3.5" />
              ) : (
                <AlignRight className="h-3.5 w-3.5" />
              )}
            </button>
          ))}
          {singleText && (
            <input
              value={singleText.text}
              onChange={(e) => updateElement(singleText.id, { text: e.target.value })}
              aria-label="Text content"
              className={`${inputCls} w-52 py-1 text-[12px]`}
              placeholder="Text content"
            />
          )}
        </div>
      )}

      {selected.length === 1 && selected[0]!.type === "image" && (
        <BgRemovalControl key={selected[0]!.id} el={selected[0]! as ImageElement} />
      )}

      {selected.length === 1 && selected[0]!.type === "chart" && (
        <ChartDataEditor key={selected[0]!.id} el={selected[0]! as ChartElement} />
      )}

      {selected.length === 1 && selected[0]!.type === "qr" && (
        <QrEditor key={selected[0]!.id} el={selected[0]! as QrElement} />
      )}

      {selected.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <label className="flex items-center gap-1 text-[12px] text-muted" title="Opacity">
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round((selected[0]!.opacity ?? 1) * 100)}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10) / 100;
                for (const el of selected) updateElement(el.id, { opacity: v });
              }}
              className="h-1 w-20 accent-ink"
            />
          </label>
          <input
            type="color"
            value={(() => {
              const el = selected[0]!;
              if (el.type === "line") return el.stroke;
              if (el.type === "image") return "#ffffff";
              if (el.type === "chart") return el.colors[0] ?? "#7c3aed";
              if (el.type === "qr") return el.foreground;
              return el.fill;
            })()}
            onChange={(e) => {
              for (const el of selected) {
                const patch = fillablePatch(el, e.target.value);
                if (Object.keys(patch).length > 0) updateElement(el.id, patch);
              }
            }}
            className="h-7 w-8 cursor-pointer rounded border border-line bg-paper p-0.5"
            title="Fill color"
          />
          <button
            onClick={() => {
              for (const el of selected) updateElement(el.id, { locked: !el.locked });
            }}
            className={allLocked ? iconBtnActive : iconBtn}
            title={allLocked ? "Unlock selection" : "Lock selection"}
          >
            {allLocked ? <Lock className="h-3.5 w-3.5" /> : <Unlock className="h-3.5 w-3.5" />}
          </button>
          <button onClick={() => duplicateElements(selectedIds)} className={iconBtn} title="Duplicate (Ctrl+D)">
            <Copy className="h-3.5 w-3.5" />
          </button>
          <button onClick={() => removeElements(selectedIds)} className={iconBtn} title="Delete (Del)">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
          <div className="flex items-center gap-0.5">
            <button onClick={() => zOrder("forward")} className={iconBtn} title="Bring forward">
              <ArrowUpFromLine className="h-3.5 w-3.5" />
            </button>
            <button onClick={() => zOrder("backward")} className={iconBtn} title="Send backward">
              <ArrowDownToLine className="h-3.5 w-3.5" />
            </button>
          </div>
          {selected.length > 1 && (
            <div className="flex items-center gap-0.5">
              {align.map((a) => (
                <button
                  key={a.edge}
                  onClick={() => alignElements(selectedIds, a.edge)}
                  className={iconBtn}
                  title={a.label}
                >
                  {a.icon}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="ml-auto flex items-center gap-1.5">
        <button
          onClick={() => setBatchOpen(true)}
          className={btnGhost}
          title="Batch generate variants from {{variables}} on this page"
        >
          <Wand2 className="h-4 w-4" />
          Batch
        </button>
        <button
          onClick={() => setShareOpen(true)}
          className={btnGhost}
          title="Share links, comments, and approval"
        >
          <Share2 className="h-4 w-4" />
          Share
        </button>
        <button onClick={undo} disabled={!canUndo()} className={iconBtn} title="Undo (Ctrl+Z)">
          <Undo className="h-4 w-4" />
        </button>
        <button onClick={redo} disabled={!canRedo()} className={iconBtn} title="Redo (Ctrl+Y)">
          <Redo className="h-4 w-4" />
        </button>
        <div ref={exportRef} className="relative">
          <button
            onClick={() => setExportOpen((o) => !o)}
            disabled={exporting}
            className={btnGhost}
          >
            <Download className="h-4 w-4" />
            {exporting ? <span className="aos-shape aos-shape--running aos-is-live" /> : null}{exporting ? "Exporting…" : "Export"}
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
          {exportOpen && (
            <div className="absolute right-0 z-30 mt-1 w-36 overflow-hidden rounded-md border border-line bg-paper shadow-overlay">
              {(
                [
                  ["png", "PNG image"],
                  ["jpg", "JPG image"],
                  ["svg", "SVG vector"],
                  ["pdf", "PDF document"],
                ] as const
              ).map(([fmt, label]) => (
                <button
                  key={fmt}
                  onClick={() => void doExport(fmt)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-ink hover:bg-hover-paper"
                >
                  <Check className="h-3.5 w-3.5 invisible" />
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>
        {saveLabel && (
          <span
            className={`flex items-center gap-1 text-[12px] ${
              saveState === "error" ? "text-failed-text" : "text-muted"
            }`}
          >
            {saveState === "saving" && <span className="aos-shape aos-shape--running aos-is-live" />}
            {saveState === "saved" && <Check className="h-3.5 w-3.5 text-ink" />}
            {saveState === "error" && <span className="aos-shape aos-shape--failed" />}
            {saveLabel}
          </span>
        )}
      </div>

      {notice && (
        <div className="fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 animate-toast-in items-center gap-3 rounded-lg bg-night py-2.5 pl-4 pr-2.5 text-[13px] text-night-soft shadow-toast">
          <Check className="h-4 w-4 shrink-0 text-white" />
          <span>{notice}</span>
          <button
            onClick={() => {
              undo();
              setNotice(null);
            }}
            className="rounded-full bg-white px-3 py-1 text-[12px] font-semibold text-ink aos-press hover:bg-hover-paper"
          >
            Undo
          </button>
          <button
            onClick={() => setNotice(null)}
            aria-label="Dismiss"
            className="rounded-full p-1 text-night-muted hover:bg-night-hover hover:text-white"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      <BatchModal
        open={batchOpen}
        onClose={() => setBatchOpen(false)}
        onGenerated={onBatchGenerated}
      />
      <ShareModal designId={designId} open={shareOpen} onClose={() => setShareOpen(false)} />
    </div>
  );
}
