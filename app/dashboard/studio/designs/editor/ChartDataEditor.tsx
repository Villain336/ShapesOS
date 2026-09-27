// Marketr — Phase 11 "Canvas": chart data editor. Edits a selected chart
// element's series (labels, values, per-series colors), chart type, and value
// labels. Every change commits an undoable store patch.

"use client";

import { useState } from "react";
import { BarChart3, LineChart, PieChart, Plus, Trash2 } from "lucide-react";
import type { ChartElement } from "@/lib/design/types";
import { useCanvasStore } from "@/lib/design/store";
import { DEFAULT_FACTORY_COLORS } from "./factory";

const TYPE_TABS = [
  { key: "bar", label: "Bar", icon: <BarChart3 className="h-3.5 w-3.5" /> },
  { key: "line", label: "Line", icon: <LineChart className="h-3.5 w-3.5" /> },
  { key: "pie", label: "Pie", icon: <PieChart className="h-3.5 w-3.5" /> },
] as const;

export function ChartDataEditor({ el }: { el: ChartElement }) {
  const updateElement = useCanvasStore((s) => s.updateElement);
  const [open, setOpen] = useState(false);

  const set = (patch: Partial<ChartElement>) => updateElement(el.id, patch);

  const updateRow = (i: number, label: string, value: number) => {
    const labels = [...el.labels];
    const values = [...el.values];
    labels[i] = label;
    values[i] = value;
    set({ labels, values });
  };

  const updateColor = (i: number, color: string) => {
    const colors = [...el.colors];
    colors[i] = color;
    set({ colors });
  };

  const addRow = () => {
    const n = el.labels.length + 1;
    set({
      labels: [...el.labels, `Item ${n}`],
      values: [...el.values, 10],
      colors: [...el.colors, DEFAULT_FACTORY_COLORS[n % DEFAULT_FACTORY_COLORS.length]!],
    });
  };

  const removeRow = (i: number) => {
    if (el.labels.length <= 1) return;
    set({
      labels: el.labels.filter((_, j) => j !== i),
      values: el.values.filter((_, j) => j !== i),
      colors: el.colors.filter((_, j) => j !== i),
    });
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded-md border border-stone-200 bg-white px-2.5 py-1 text-[12px] text-stone-700 hover:bg-stone-50"
        title="Edit chart data and colors"
      >
        <BarChart3 className="h-3.5 w-3.5 text-violet-600" />
        Chart data
      </button>
      {open && (
        <div className="absolute left-0 z-30 mt-1 w-80 overflow-hidden rounded-md border border-stone-200 bg-white shadow-lg">
          <div className="flex items-center gap-1 border-b border-stone-100 p-2">
            {TYPE_TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => set({ chartType: t.key })}
                className={`flex flex-1 items-center justify-center gap-1 rounded px-2 py-1.5 text-[12px] font-medium ${
                  el.chartType === t.key
                    ? "bg-violet-100 text-violet-700"
                    : "text-stone-500 hover:bg-stone-100"
                }`}
              >
                {t.icon}
                {t.label}
              </button>
            ))}
          </div>
          <div className="max-h-56 space-y-1 overflow-y-auto p-2">
            {el.labels.map((label, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <input
                  type="color"
                  value={el.colors[i] ?? DEFAULT_FACTORY_COLORS[i % DEFAULT_FACTORY_COLORS.length]}
                  onChange={(e) => updateColor(i, e.target.value)}
                  className="h-7 w-7 shrink-0 cursor-pointer rounded border border-stone-200 bg-white p-0.5"
                  title={`Series ${i + 1} color`}
                />
                <input
                  value={label}
                  onChange={(e) => updateRow(i, e.target.value, el.values[i] ?? 0)}
                  className="min-w-0 flex-1 rounded border border-stone-200 px-1.5 py-1 text-[12px] focus:border-violet-400 focus:outline-none"
                  aria-label={`Label ${i + 1}`}
                />
                <input
                  type="number"
                  value={el.values[i] ?? 0}
                  onChange={(e) => updateRow(i, label, parseFloat(e.target.value) || 0)}
                  className="w-16 shrink-0 rounded border border-stone-200 px-1.5 py-1 text-[12px] focus:border-violet-400 focus:outline-none"
                  aria-label={`Value ${i + 1}`}
                />
                <button
                  onClick={() => removeRow(i)}
                  disabled={el.labels.length <= 1}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-stone-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-30"
                  title="Remove series"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
          <div className="flex items-center justify-between border-t border-stone-100 p-2">
            <button
              onClick={addRow}
              className="flex items-center gap-1 rounded px-2 py-1 text-[12px] font-medium text-violet-700 hover:bg-violet-50"
            >
              <Plus className="h-3.5 w-3.5" />
              Add series
            </button>
            <label className="flex items-center gap-1.5 text-[12px] text-stone-600">
              <input
                type="checkbox"
                checked={el.showValues}
                onChange={(e) => set({ showValues: e.target.checked })}
                className="accent-violet-600"
              />
              Show values
            </label>
          </div>
        </div>
      )}
    </div>
  );
}
