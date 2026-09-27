// Marketr — Phase 11 "Canvas": Text panel. One click drops a preset at page center.

"use client";

import { useCanvasStore } from "@/lib/design/store";
import { makeRect, makeText } from "../factory";
import { panelSectionLabel, panelTitle } from "../ui";

const PRESETS = [
  { label: "Heading", fontSize: 64, fontStyle: "bold" as const, fill: "#1c1917" },
  { label: "Subheading", fontSize: 36, fontStyle: "bold" as const, fill: "#1c1917" },
  { label: "Body", fontSize: 20, fontStyle: "normal" as const, fill: "#44403c" },
  { label: "Caption", fontSize: 14, fontStyle: "normal" as const, fill: "#78716c" },
];

export function TextPanel() {
  const document = useCanvasStore((s) => s.document);
  const activePageId = useCanvasStore((s) => s.activePageId);
  const addElement = useCanvasStore((s) => s.addElement);
  const select = useCanvasStore((s) => s.select);

  const page = document?.pages.find((p) => p.id === activePageId);
  if (!page) return null;

  const addPreset = (p: (typeof PRESETS)[number]) => {
    addElement(
      makeText({
        text: p.label === "Body" ? "Body copy goes here." : p.label,
        fontSize: p.fontSize,
        fontStyle: p.fontStyle,
        fill: p.fill,
        pageW: page.width,
        pageH: page.height,
        name: p.label,
      })
    );
  };

  const addCta = () => {
    const pillW = 240;
    const pillH = 68;
    const rect = makeRect({
      width: pillW,
      height: pillH,
      fill: "#7c3aed",
      cornerRadius: 999,
      pageW: page.width,
      pageH: page.height,
      name: "CTA pill",
    });
    const label = makeText({
      text: "Get started",
      fontSize: 26,
      fontStyle: "bold",
      fill: "#ffffff",
      width: pillW,
      pageW: page.width,
      pageH: page.height,
      name: "CTA label",
    });
    // Center the label on the pill.
    label.y = rect.y + pillH / 2 - 26 / 2 - 4;
    addElement(rect);
    addElement(label);
    select([rect.id, label.id]);
  };

  return (
    <div>
      <div className={panelTitle}>Text</div>
      <div className="space-y-1.5 px-3 pb-4">
        <div className={panelSectionLabel}>Presets</div>
        {PRESETS.map((p) => (
          <button
            key={p.label}
            onClick={() => addPreset(p)}
            className="block w-full rounded-md border border-stone-200 bg-white px-3 py-2 text-left hover:border-violet-400 hover:bg-violet-50/40"
          >
            <span
              className="block truncate text-stone-900"
              style={{ fontSize: Math.min(p.fontSize, 28), fontWeight: p.fontStyle === "bold" ? 700 : 400, color: p.fill }}
            >
              {p.label}
            </span>
            <span className="text-[11px] text-stone-500">
              {p.label} · {p.fontSize}px{p.fontStyle === "bold" ? " · bold" : ""}
            </span>
          </button>
        ))}
        <div className={`${panelSectionLabel} pt-2`}>Call to action</div>
        <button
          onClick={addCta}
          className="flex w-full items-center justify-center rounded-full bg-violet-600 px-3 py-2.5 text-[14px] font-semibold text-white hover:bg-violet-700"
        >
          CTA button
        </button>
        <p className="pt-1 text-[11px] leading-snug text-stone-500">
          Adds a violet pill with a centered label as two elements. Select the label to edit its text in the toolbar.
        </p>
      </div>
    </div>
  );
}
