// Marketr — Phase 11 "Canvas": Templates panel.
// Thumbnails are honest CSS mocks (colored block + size label), never rendered
// previews. Applying a template REPLACES the whole document (with confirm).

"use client";

import { useMemo, useState } from "react";
import { useCanvasStore } from "@/lib/design/store";
import { ALL_TEMPLATES } from "@/lib/design/templates";
import type { DesignTemplate } from "@/lib/design/types";
import { btnGhost, inputCls, panelSectionLabel, panelTitle } from "../ui";

const CATEGORIES = ["all", "social", "ads", "web", "print"] as const;

const BLANK_PRESETS = [
  { name: "Square post", w: 1080, h: 1080 },
  { name: "Story / Reel", w: 1080, h: 1920 },
  { name: "Landscape", w: 1920, h: 1080 },
  { name: "Wide banner", w: 1200, h: 628 },
  { name: "A4 print", w: 1240, h: 1754 },
];

const CATEGORY_TINT: Record<DesignTemplate["category"], string> = {
  social: "bg-canvas",
  ads: "bg-canvas",
  web: "bg-canvas",
  print: "bg-canvas",
};

interface TemplatesPanelProps {
  /** Called after the document is replaced so the host can save immediately. */
  onDocumentReplaced: () => void;
}

export function TemplatesPanel({ onDocumentReplaced }: TemplatesPanelProps) {
  const loadDocument = useCanvasStore((s) => s.loadDocument);
  const addPage = useCanvasStore((s) => s.addPage);
  const setPageSize = useCanvasStore((s) => s.setPageSize);
  const renamePage = useCanvasStore((s) => s.renamePage);
  const [customW, setCustomW] = useState("1080");
  const [customH, setCustomH] = useState("1080");
  const [query, setQuery] = useState("");
  const [cat, setCat] = useState<(typeof CATEGORIES)[number]>("all");

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return ALL_TEMPLATES.filter(
      (t) =>
        (cat === "all" || t.category === cat) &&
        (!q ||
          t.name.toLowerCase().includes(q) ||
          t.description.toLowerCase().includes(q)),
    );
  }, [query, cat]);

  const applyTemplate = (t: DesignTemplate) => {
    const ok = window.confirm(
      `Replace the entire document with the "${t.name}" template (${t.width} × ${t.height})? This cannot be undone.`
    );
    if (!ok) return;
    loadDocument(t.build());
    onDocumentReplaced();
  };

  const createBlankPage = (w: number, h: number, name: string) => {
    addPage();
    const activeId = useCanvasStore.getState().activePageId;
    if (!activeId) return;
    setPageSize(activeId, w, h);
    renamePage(activeId, name);
  };

  const createCustom = () => {
    const w = Math.min(4000, Math.max(100, parseInt(customW, 10) || 1080));
    const h = Math.min(4000, Math.max(100, parseInt(customH, 10) || 1080));
    createBlankPage(w, h, `Blank ${w}×${h}`);
  };

  return (
    <div>
      <div className={panelTitle}>Templates</div>
      <div className="space-y-4 px-3 pb-4">
        <div>
          <div className={panelSectionLabel}>Blank canvas</div>
          <div className="grid grid-cols-2 gap-1.5">
            {BLANK_PRESETS.map((p) => (
              <button
                key={p.name}
                onClick={() => createBlankPage(p.w, p.h, p.name)}
                className="rounded-md border border-line bg-paper px-2 py-1.5 text-left hover:border-line-strong"
              >
                <div className="text-[12px] font-medium text-ink">{p.name}</div>
                <div className="text-[11px] text-muted">
                  {p.w} × {p.h}
                </div>
              </button>
            ))}
          </div>
          <div className="mt-2 flex items-center gap-1.5">
            <input
              value={customW}
              onChange={(e) => setCustomW(e.target.value)}
              inputMode="numeric"
              aria-label="Custom width"
              className={`${inputCls} w-full px-2 py-1 text-[12px]`}
            />
            <span className="text-subtle">×</span>
            <input
              value={customH}
              onChange={(e) => setCustomH(e.target.value)}
              inputMode="numeric"
              aria-label="Custom height"
              className={`${inputCls} w-full px-2 py-1 text-[12px]`}
            />
            <button onClick={createCustom} className={`${btnGhost} shrink-0 px-2 py-1 text-[12px]`}>
              Create
            </button>
          </div>
        </div>

        <div>
          <div className={panelSectionLabel}>
            Starter templates · {visible.length} of {ALL_TEMPLATES.length}
          </div>
          <div className="mb-2 flex items-center gap-1.5">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search templates…"
              aria-label="Search templates"
              className={`${inputCls} w-full px-2 py-1 text-[12px]`}
            />
          </div>
          <div className="mb-2 flex flex-wrap gap-1">
            {CATEGORIES.map((c) => (
              <button
                key={c}
                onClick={() => setCat(c)}
                className={`rounded-full px-2 py-0.5 text-[11px] font-medium capitalize ${
                  cat === c
                    ? "bg-ink text-white"
                    : "border border-line bg-paper text-muted hover:border-line-strong hover:text-ink"
                }`}
              >
                {c}
              </button>
            ))}
          </div>
          <div className="grid max-h-[420px] grid-cols-2 gap-2 overflow-y-auto pr-0.5">
            {visible.map((t) => (
              <div
                key={t.key}
                className="overflow-hidden rounded-md border border-line bg-paper"
              >
                <div
                  className={`flex h-20 items-center justify-center ${CATEGORY_TINT[t.category]}`}
                >
                  <span className="rounded bg-paper px-1.5 py-0.5 text-[10px] font-medium text-muted shadow-hairline">
                    {t.width} × {t.height}
                  </span>
                </div>
                <div className="px-2 py-1.5">
                  <div className="truncate text-[12px] font-medium text-ink">{t.name}</div>
                  <div className="truncate text-[11px] capitalize text-muted">{t.category}</div>
                  <button
                    onClick={() => applyTemplate(t)}
                    className="mt-1 w-full rounded-full border border-line bg-paper px-2 py-1 text-[11px] font-medium text-ink shadow-outline hover:bg-hover-paper"
                  >
                    Apply
                  </button>
                </div>
              </div>
            ))}
          </div>
          <p className="pt-2 text-[11px] leading-snug text-subtle">
            Applying a template replaces the whole document — confirm first.
          </p>
        </div>
      </div>
    </div>
  );
}
