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
        className="w-56 rounded-md border border-stone-200 bg-white px-2 py-1 text-[12px] focus:border-violet-400 focus:outline-none"
        title="QR payload (URL or text)"
      />
      <label className="flex items-center gap-1 text-[12px] text-stone-600" title="QR foreground">
        <input
          type="color"
          value={el.foreground}
          onChange={(e) => updateElement(el.id, { foreground: e.target.value })}
          className="h-7 w-8 cursor-pointer rounded border border-stone-200 bg-white p-0.5"
        />
        Code
      </label>
      <label className="flex items-center gap-1 text-[12px] text-stone-600" title="QR background">
        <input
          type="color"
          value={el.background}
          onChange={(e) => updateElement(el.id, { background: e.target.value })}
          className="h-7 w-8 cursor-pointer rounded border border-stone-200 bg-white p-0.5"
        />
        Background
      </label>
    </div>
  );
}
