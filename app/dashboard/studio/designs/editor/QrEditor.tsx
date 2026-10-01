// Marketr — Phase 11 "Canvas": QR payload and color editor for a selected
// QR element. Every change commits an undoable store patch.

"use client";

import type { QrElement } from "@/lib/design/types";
import { useCanvasStore } from "@/lib/design/store";

export function QrEditor({ el }: { el: QrElement }) {
  const updateElement = useCanvasStore((s) => s.updateElement);

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <input
        value={el.payload}
        onChange={(e) => updateElement(el.id, { payload: e.target.value })}
        aria-label="QR payload"
        placeholder="https://… or text"
        className="h-8 w-56 rounded-md border-[1.5px] border-control bg-paper px-2 text-[12px] text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)] focus-visible:outline-none"
        title="QR payload (URL or text)"
      />
      <label className="flex items-center gap-1 text-[12px] text-muted" title="QR foreground">
        <input
          type="color"
          value={el.foreground}
          onChange={(e) => updateElement(el.id, { foreground: e.target.value })}
          className="h-7 w-8 cursor-pointer rounded border border-line bg-paper p-0.5"
        />
        Code
      </label>
      <label className="flex items-center gap-1 text-[12px] text-muted" title="QR background">
        <input
          type="color"
          value={el.background}
          onChange={(e) => updateElement(el.id, { background: e.target.value })}
          className="h-7 w-8 cursor-pointer rounded border border-line bg-paper p-0.5"
        />
        Background
      </label>
    </div>
  );
}
