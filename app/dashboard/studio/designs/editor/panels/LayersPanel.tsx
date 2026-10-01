// Marketr — Phase 11 "Canvas": Layers panel. Top-first element list with
// visibility, lock, select, rename (double-click), and up/down reordering.

"use client";

import {
  ChevronDown,
  ChevronUp,
  Circle,
  Eye,
  EyeOff,
  Image as ImageIcon,
  Lock,
  Minus,
  Shapes,
  Square,
  Type,
  Unlock,
} from "lucide-react";
import { useCanvasStore } from "@/lib/design/store";
import type { DesignElement } from "@/lib/design/types";
import { panelTitle } from "../ui";

function TypeIcon({ type }: { type: DesignElement["type"] }) {
  const cls = "h-3.5 w-3.5 shrink-0 text-muted";
  switch (type) {
    case "text":
      return <Type className={cls} />;
    case "image":
      return <ImageIcon className={cls} />;
    case "rect":
      return <Square className={cls} />;
    case "ellipse":
      return <Circle className={cls} />;
    case "line":
      return <Minus className={cls} />;
    case "svg":
      return <Shapes className={cls} />;
  }
}

export function LayersPanel() {
  const document = useCanvasStore((s) => s.document);
  const activePageId = useCanvasStore((s) => s.activePageId);
  const selectedIds = useCanvasStore((s) => s.selectedIds);
  const select = useCanvasStore((s) => s.select);
  const updateElement = useCanvasStore((s) => s.updateElement);
  const moveElement = useCanvasStore((s) => s.moveElement);

  const page = document?.pages.find((p) => p.id === activePageId);
  if (!page) return null;

  // Top of the stack first.
  const rows = [...page.elements].reverse();

  const rename = (el: DesignElement) => {
    const next = window.prompt("Rename layer", el.name);
    if (next && next.trim()) updateElement(el.id, { name: next.trim().slice(0, 60) });
  };

  return (
    <div>
      <div className={panelTitle}>Layers · {page.name}</div>
      <div className="space-y-1 px-3 pb-4">
        {rows.length === 0 && (
          <p className="text-[12px] text-muted">This page is empty — add something from the other panels.</p>
        )}
        {rows.map((el) => {
          const selected = selectedIds.includes(el.id);
          return (
            <div
              key={el.id}
              onClick={() => select([el.id])}
              onDoubleClick={() => rename(el)}
              title="Click to select · double-click to rename"
              className={`flex cursor-pointer items-center gap-2 rounded-md border px-2 py-1.5 text-[12px] ${
                selected
                  ? "border-ink bg-hover-paper text-ink"
                  : "border-line bg-paper text-ink hover:border-line-strong"
              } ${el.visible ? "" : "opacity-50"}`}
            >
              <TypeIcon type={el.type} />
              <span className="min-w-0 flex-1 truncate font-medium">{el.name}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  moveElement(el.id, "forward");
                }}
                title="Bring forward"
                className="rounded-full p-0.5 text-subtle hover:bg-hover-paper hover:text-ink"
              >
                <ChevronUp className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  moveElement(el.id, "backward");
                }}
                title="Send backward"
                className="rounded-full p-0.5 text-subtle hover:bg-hover-paper hover:text-ink"
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  updateElement(el.id, { locked: !el.locked });
                }}
                title={el.locked ? "Unlock" : "Lock"}
                className="rounded-full p-0.5 text-subtle hover:bg-hover-paper hover:text-ink"
              >
                {el.locked ? <Lock className="h-3.5 w-3.5" /> : <Unlock className="h-3.5 w-3.5" />}
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  updateElement(el.id, { visible: !el.visible });
                }}
                title={el.visible ? "Hide" : "Show"}
                className="rounded-full p-0.5 text-subtle hover:bg-hover-paper hover:text-ink"
              >
                {el.visible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
