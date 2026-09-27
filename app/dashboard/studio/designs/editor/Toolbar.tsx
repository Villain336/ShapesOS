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
  Italic,
  Lock,
  Plus,
  Redo,
  Trash2,
  Undo,
  Unlock,
} from "lucide-react";
import { useCanvasStore, type AlignEdge } from "@/lib/design/store";
import type { DesignElement, TextElement } from "@/lib/design/types";
import type { StageRef } from "./DesignCanvas";
import { iconBtn, iconBtnActive, inputCls } from "./ui";

export type SaveState = "idle" | "saving" | "saved" | "error";

const SYSTEM_FONTS = [
  "Inter",
  "Arial",
  "Helvetica",
  "Georgia",
  "Times New Roman",
  "Courier New",
  "Verdana",
  "Trebuchet MS",
];

interface ToolbarProps {
  stageRef: StageRef;
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
  return { fill: color };
}

export function Toolbar({ stageRef, designName, onNameChange, saveState, brandFonts }: ToolbarProps) {
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
  const undo = useCanvasStore((s) => s.undo);
  const redo = useCanvasStore((s) => s.redo);
  const canUndo = useCanvasStore((s) => s.canUndo);
  const canRedo = useCanvasStore((s) => s.canRedo);

  const [exportOpen, setExportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const exportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (exportRef.current && !exportRef.current.contains(e.target as Node)) setExportOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const page = doc?.pages.find((p) => p.id === activePageId) ?? null;
  const selected = (page?.elements ?? []).filter((el) => selectedIds.includes(el.id));
  const textEls = selected.filter(isText);
  const singleText = textEls.length === 1 && selected.length === 1 ? textEls[0]! : null;
  const allLocked = selected.length > 0 && selected.every((el) => el.locked);
  const fonts = [...SYSTEM_FONTS, ...brandFonts.filter((f) => !SYSTEM_FONTS.includes(f))];

  const doExport = async (fmt: "png" | "jpg" | "pdf") => {
    const stage = stageRef.current;
    if (!stage || !page || exporting) return;
    setExporting(true);
    try {
      // Brief pause so in-flight images settle before capture.
      await new Promise((r) => setTimeout(r, 350));
      const base = (designName || "design").replace(/[^\w\- ]+/g, "").trim() || "design";
      if (fmt === "pdf") {
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
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-stone-200 bg-white px-3 py-2">
      <input
        value={designName}
        onChange={(e) => onNameChange(e.target.value)}
        aria-label="Design name"
        className="w-44 rounded-md border border-transparent px-2 py-1 text-[13px] font-semibold text-stone-900 hover:border-stone-200 focus:border-violet-400 focus:outline-none"
      />

      <div className="h-5 w-px bg-stone-200" />

      {selected.length === 0 && page && (
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-[12px] text-stone-600">
            <input
              type="color"
              value={page.background}
              onChange={(e) => setPageBackground(page.id, e.target.value)}
              className="h-7 w-8 cursor-pointer rounded border border-stone-200 bg-white p-0.5"
              title="Page background"
            />
            Background
          </label>
          <span className="rounded bg-stone-100 px-1.5 py-0.5 font-mono text-[11px] text-stone-600">
            {page.width} × {page.height}
          </span>
          <button onClick={addPage} className={iconBtn} title="Add page">
            <Plus className="h-4 w-4" />
          </button>
        </div>
      )}

      {textEls.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <select
            value={textEls[0]!.fontFamily}
            onChange={(e) => {
              for (const t of textEls) updateElement(t.id, { fontFamily: e.target.value });
            }}
            className={`${inputCls} max-w-40 py-1 text-[12px]`}
            title="Font family"
          >
            {fonts.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
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
            className="h-7 w-8 cursor-pointer rounded border border-stone-200 bg-white p-0.5"
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

      {selected.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <label className="flex items-center gap-1 text-[12px] text-stone-600" title="Opacity">
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round((selected[0]!.opacity ?? 1) * 100)}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10) / 100;
                for (const el of selected) updateElement(el.id, { opacity: v });
              }}
              className="h-1 w-20 accent-violet-600"
            />
          </label>
          <input
            type="color"
            value={(() => {
              const el = selected[0]!;
              if (el.type === "line") return el.stroke;
              if (el.type === "image") return "#ffffff";
              return el.fill;
            })()}
            onChange={(e) => {
              for (const el of selected) {
                const patch = fillablePatch(el, e.target.value);
                if (Object.keys(patch).length > 0) updateElement(el.id, patch);
              }
            }}
            className="h-7 w-8 cursor-pointer rounded border border-stone-200 bg-white p-0.5"
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
            className="flex items-center gap-1.5 rounded-md border border-stone-200 bg-white px-2.5 py-1.5 text-[13px] text-stone-700 hover:bg-stone-50 disabled:opacity-40"
          >
            <Download className="h-4 w-4" />
            {exporting ? "Exporting…" : "Export"}
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
          {exportOpen && (
            <div className="absolute right-0 z-30 mt-1 w-36 overflow-hidden rounded-md border border-stone-200 bg-white shadow-lg">
              {(
                [
                  ["png", "PNG image"],
                  ["jpg", "JPG image"],
                  ["pdf", "PDF document"],
                ] as const
              ).map(([fmt, label]) => (
                <button
                  key={fmt}
                  onClick={() => void doExport(fmt)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-stone-700 hover:bg-violet-50/40"
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
              saveState === "error" ? "text-red-600" : "text-stone-500"
            }`}
          >
            {saveState === "saved" && <Check className="h-3.5 w-3.5 text-emerald-600" />}
            {saveLabel}
          </span>
        )}
      </div>
    </div>
  );
}
