// Marketr — Phase 11 "Canvas": editor shell. Loads the design, owns layout
// (icon rail / panel column / toolbar / canvas / pages strip), zoom controls,
// autosave, and keyboard shortcuts.

"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Box,
  Image as ImageIcon,
  Layers,
  LayoutTemplate,
  MessageSquare,
  Minus,
  Palette,
  Plus,
  Shapes,
  Sparkles,
  Sticker,
  Type,
  Upload,
} from "lucide-react";
import type Konva from "konva";
import { useCanvasStore } from "@/lib/design/store";
import type { DesignDocument } from "@/lib/design/types";
import { Toolbar, type SaveState } from "./Toolbar";
import { PagesStrip } from "./PagesStrip";
import { TemplatesPanel } from "./panels/TemplatesPanel";
import { TextPanel } from "./panels/TextPanel";
import { UploadsPanel } from "./panels/UploadsPanel";
import { StockPhotosPanel } from "./panels/StockPhotosPanel";
import { ThreeDPanel } from "./panels/ThreeDPanel";
import { ElementsPanel } from "./panels/ElementsPanel";
import { IconsPanel } from "./panels/IconsPanel";
import { BrandPanel } from "./panels/BrandPanel";
import { LayersPanel } from "./panels/LayersPanel";
import { CommentsPanel } from "./panels/CommentsPanel";
import { AiPanel } from "./panels/AiPanel";

// react-konva needs a real DOM — never SSR it.
const DesignCanvas = dynamic(() => import("./DesignCanvas").then((m) => m.DesignCanvas), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-[13px] text-stone-500">
      Loading canvas…
    </div>
  ),
});

type PanelKey = "templates" | "text" | "uploads" | "photos" | "3d" | "elements" | "icons" | "brand" | "layers" | "comments" | "ai";

const RAIL: { key: PanelKey; label: string; icon: React.ReactNode }[] = [
  { key: "templates", label: "Templates", icon: <LayoutTemplate className="h-5 w-5" /> },
  { key: "text", label: "Text", icon: <Type className="h-5 w-5" /> },
  { key: "uploads", label: "Uploads", icon: <Upload className="h-5 w-5" /> },
  { key: "photos", label: "Photos", icon: <ImageIcon className="h-5 w-5" /> },
  { key: "3d", label: "3D", icon: <Box className="h-5 w-5" /> },
  { key: "elements", label: "Elements", icon: <Shapes className="h-5 w-5" /> },
  { key: "icons", label: "Icons", icon: <Sticker className="h-5 w-5" /> },
  { key: "brand", label: "Brand", icon: <Palette className="h-5 w-5" /> },
  { key: "layers", label: "Layers", icon: <Layers className="h-5 w-5" /> },
  { key: "comments", label: "Comments", icon: <MessageSquare className="h-5 w-5" /> },
  { key: "ai", label: "AI", icon: <Sparkles className="h-5 w-5" /> },
];

interface DesignPayload {
  id: string;
  name: string;
  document: DesignDocument;
  templateKey: string | null;
  brandKitId: string | null;
  updatedAt: string;
}

export function CanvasEditor({ designId }: { designId: string }) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [designName, setDesignName] = useState("Untitled design");
  const [panel, setPanel] = useState<PanelKey>("templates");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [brandFonts, setBrandFonts] = useState<string[]>([]);
  const [saveNonce, setSaveNonce] = useState(0);

  const document = useCanvasStore((s) => s.document);
  const activePageId = useCanvasStore((s) => s.activePageId);
  const dirty = useCanvasStore((s) => s.dirty);
  const zoom = useCanvasStore((s) => s.zoom);
  const setZoom = useCanvasStore((s) => s.setZoom);
  const loadDocument = useCanvasStore((s) => s.loadDocument);

  const stageRef = useRef<Konva.Stage | null>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // ── Load ────────────────────────────────────────────────────────────
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await fetch(`/api/studio/designs/${designId}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { design: DesignPayload };
        if (!live) return;
        setDesignName(data.design.name || "Untitled design");
        const doc = data.design.document;
        if (!doc || !Array.isArray(doc.pages) || doc.pages.length === 0) {
          throw new Error("Design document is empty or invalid.");
        }
        loadDocument(doc);
      } catch (e) {
        if (live) setLoadError(e instanceof Error ? e.message : "Could not load design.");
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [designId]);

  // ── Save ────────────────────────────────────────────────────────────
  const doSave = useCallback(async () => {
    const state = useCanvasStore.getState();
    const doc = state.document;
    if (!doc) return;
    setSaveState("saving");
    try {
      let thumbnail: string | undefined;
      try {
        thumbnail = stageRef.current?.toDataURL({ pixelRatio: 0.15, mimeType: "image/png" });
      } catch {
        thumbnail = undefined;
      }
      const res = await fetch(`/api/studio/designs/${designId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: designName,
          document: doc,
          thumbnail,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      state.markClean();
      setSaveState("saved");
    } catch {
      setSaveState("error");
    }
  }, [designId, designName]);


  useEffect(() => {
    if (loading || loadError || !document) return;
    if (!dirty && saveNonce === 0) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void doSave(), 2000);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [dirty, designName, saveNonce, loading, loadError, document, doSave]);

  // A template replace resets dirty in the store — force a save pass.
  const onDocumentReplaced = useCallback(() => setSaveNonce((n) => n + 1), []);

  // ── Keyboard ────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) {
        return;
      }
      const s = useCanvasStore.getState();
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        s.undo();
      } else if ((mod && e.key.toLowerCase() === "y") || (mod && e.shiftKey && e.key.toLowerCase() === "z")) {
        e.preventDefault();
        s.redo();
      } else if (mod && e.key.toLowerCase() === "d") {
        e.preventDefault();
        if (s.selectedIds.length > 0) s.duplicateElements(s.selectedIds);
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        if (s.selectedIds.length > 0) s.removeElements(s.selectedIds);
      } else if (e.key === "Escape") {
        s.clearSelection();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ── Zoom ────────────────────────────────────────────────────────────
  const page = document?.pages.find((p) => p.id === activePageId) ?? null;
  const fitZoom = () => {
    const el = workspaceRef.current;
    if (!el || !page) return;
    const rect = el.getBoundingClientRect();
    setZoom(Math.min((rect.width - 120) / page.width, (rect.height - 120) / page.height));
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center bg-[#FAFAF7] text-[13px] text-stone-500">
        Loading design…
      </div>
    );
  }

  if (loadError || !document) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-[#FAFAF7] px-6 text-center">
        <p className="text-[14px] font-semibold text-stone-900">Could not load this design</p>
        <p className="max-w-md text-[13px] text-stone-500">
          {loadError ?? "The design came back empty."} The designs API may still be landing — try again in a moment.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full bg-[#FAFAF7]">
      {/* Icon rail */}
      <div className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-stone-200 bg-white py-2">
        {RAIL.map((r) => (
          <button
            key={r.key}
            onClick={() => setPanel(r.key)}
            title={r.label}
            className={`flex h-10 w-10 flex-col items-center justify-center gap-0.5 rounded-md text-[9px] font-medium ${
              panel === r.key
                ? "bg-violet-50 text-violet-700"
                : "text-stone-500 hover:bg-stone-100 hover:text-stone-800"
            }`}
          >
            {r.icon}
            <span className="leading-none">{r.label}</span>
          </button>
        ))}
      </div>

      {/* Panel column */}
      <div className="w-64 shrink-0 overflow-y-auto border-r border-stone-200 bg-white">
        {panel === "templates" && <TemplatesPanel onDocumentReplaced={onDocumentReplaced} />}
        {panel === "text" && <TextPanel />}
        {panel === "uploads" && <UploadsPanel />}
        {panel === "photos" && <StockPhotosPanel />}
        {panel === "3d" && <ThreeDPanel />}
        {panel === "elements" && <ElementsPanel />}
        {panel === "icons" && <IconsPanel />}
        {panel === "brand" && <BrandPanel onFontsLoaded={setBrandFonts} />}
        {panel === "layers" && <LayersPanel />}
        {panel === "comments" && <CommentsPanel designId={designId} />}
        {panel === "ai" && <AiPanel />}
      </div>

      {/* Center column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <Toolbar
          stageRef={stageRef}
          designId={designId}
          designName={designName}
          onNameChange={(n) => {
            setDesignName(n);
          }}
          saveState={saveState}
          brandFonts={brandFonts}
        />

        <div ref={workspaceRef} className="relative min-h-0 flex-1 overflow-auto bg-stone-100">
          <DesignCanvas stageRef={stageRef} />

          {/* Zoom controls */}
          <div className="absolute bottom-3 right-3 z-20 flex items-center gap-0.5 rounded-md border border-stone-200 bg-white px-1 py-1 shadow-sm">
            <button
              onClick={() => setZoom(zoom - 0.1)}
              className="flex h-6 w-6 items-center justify-center rounded text-stone-600 hover:bg-stone-100"
              title="Zoom out"
            >
              <Minus className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={fitZoom}
              className="min-w-12 rounded px-1 text-center text-[11px] font-medium text-stone-700 hover:bg-stone-100"
              title="Fit to screen"
            >
              {Math.round(zoom * 100)}%
            </button>
            <button
              onClick={() => setZoom(zoom + 0.1)}
              className="flex h-6 w-6 items-center justify-center rounded text-stone-600 hover:bg-stone-100"
              title="Zoom in"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={fitZoom}
              className="rounded px-1.5 py-0.5 text-[11px] font-medium text-violet-700 hover:bg-violet-50"
              title="Fit page to screen"
            >
              Fit
            </button>
          </div>
        </div>

        <PagesStrip />
      </div>
    </div>
  );
}
