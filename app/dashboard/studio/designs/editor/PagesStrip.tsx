// Marketr — Phase 11 "Canvas": bottom pages strip. CSS-block thumbnails
// (aspect-correct, page background, element count) with add / duplicate /
// rename / delete per page.

"use client";

import { Copy, Pencil, Plus, Trash2 } from "lucide-react";
import { useCanvasStore } from "@/lib/design/store";
import { confirmAction } from "@/lib/ui/feedback";

export function PagesStrip() {
  const document = useCanvasStore((s) => s.document);
  const activePageId = useCanvasStore((s) => s.activePageId);
  const setActivePage = useCanvasStore((s) => s.setActivePage);
  const addPage = useCanvasStore((s) => s.addPage);
  const duplicatePage = useCanvasStore((s) => s.duplicatePage);
  const removePage = useCanvasStore((s) => s.removePage);
  const renamePage = useCanvasStore((s) => s.renamePage);

  if (!document) return null;

  return (
    <div className="flex shrink-0 items-center gap-2 overflow-x-auto border-t border-line bg-paper px-3 py-2">
      {document.pages.map((page, i) => {
        const active = page.id === activePageId;
        const aspect = page.width / Math.max(1, page.height);
        return (
          <div key={page.id} className="group relative shrink-0">
            <button
              onClick={() => setActivePage(page.id)}
              title={`${page.name} · ${page.width} × ${page.height}`}
              className={`flex h-16 w-24 flex-col items-center justify-center overflow-hidden rounded-md border bg-white ${
                active ? "border-ink ring-1 ring-ink" : "border-line hover:border-line-strong"
              }`}
            >
              <span
                className="flex items-center justify-center rounded-[2px] border border-line"
                style={{
                  backgroundColor: page.background,
                  width: aspect >= 1 ? 44 : Math.max(14, 44 * aspect),
                  height: aspect >= 1 ? Math.max(10, 32 / aspect) : 32,
                }}
              >
                <span className="text-[0.5625rem] font-medium text-muted">{page.elements.length}</span>
              </span>
              <span className="mt-1 max-w-full truncate px-1 text-[0.625rem] text-muted">
                {i + 1}. {page.name}
              </span>
            </button>
            <div className="absolute -top-1 right-0 hidden gap-0.5 group-hover:flex">
              <button
                onClick={() => {
                  const next = window.prompt("Rename page", page.name);
                  if (next?.trim()) renamePage(page.id, next.trim().slice(0, 40));
                }}
                title="Rename page"
                className="rounded bg-paper p-0.5 text-muted shadow-outline hover:text-ink"
              >
                <Pencil className="h-3 w-3" />
              </button>
              <button
                onClick={() => duplicatePage(page.id)}
                title="Duplicate page"
                className="rounded bg-paper p-0.5 text-muted shadow-outline hover:text-ink"
              >
                <Copy className="h-3 w-3" />
              </button>
              {document.pages.length > 1 && (
                <button
                  onClick={async () => {
                    if (await confirmAction(`Delete "${page.name}"?`)) removePage(page.id);
                  }}
                  title="Delete page"
                  className="rounded bg-paper p-0.5 text-muted shadow-outline hover:text-failed-text"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              )}
            </div>
          </div>
        );
      })}
      <button
        onClick={addPage}
        title="Add page"
        className="flex h-16 w-12 shrink-0 items-center justify-center rounded-md border border-dashed border-control text-subtle hover:border-ink hover:text-ink"
      >
        <Plus className="h-4 w-4" />
      </button>
    </div>
  );
}
