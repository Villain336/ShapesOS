// Marketr — Phase 11 "Canvas": Text panel. One click drops a preset at page
// center. With a single text element selected: per-range rich-text styling
// (FEATURE 1) and text-on-a-path controls.

"use client";

import { useState } from "react";
import { Bold, Eraser, Italic, Spline, X } from "lucide-react";
import { useCanvasStore } from "@/lib/design/store";
import type { TextElement } from "@/lib/design/types";
import { makeRect, makeText } from "../factory";
import {
  btnGhost,
  iconBtn,
  iconBtnActive,
  inputCls,
  panelSectionLabel,
  panelTitle,
} from "../ui";
import {
  TEXT_PATH_PRESETS,
  baseStyleOf,
  hasRichFragments,
  rangeHasFlag,
  rangeUniformStyle,
  toggleFragmentFlag,
} from "@/lib/design/rich-text";
import { FontPicker } from "../FontPicker";
import { PANEL_FONTS } from "@/lib/design/fonts";

// Legit literal hex: default fills written into the user's design document
// (Konva canvas, exported to PNG/PDF), not UI chrome.
const PRESETS = [
  { label: "Heading", fontSize: 64, fontStyle: "bold" as const, fill: "#1c1917" },
  { label: "Subheading", fontSize: 36, fontStyle: "bold" as const, fill: "#1c1917" },
  { label: "Body", fontSize: 20, fontStyle: "normal" as const, fill: "#44403c" },
  { label: "Caption", fontSize: 14, fontStyle: "normal" as const, fill: "#78716c" },
];

interface Range {
  start: number;
  end: number;
}

/** FEATURE 1: select a character range, style just that range. */
function RichTextControls({ el }: { el: TextElement }) {
  const applyFragmentStyle = useCanvasStore((s) => s.applyFragmentStyle);
  const clearFragments = useCanvasStore((s) => s.clearFragments);
  const updateElement = useCanvasStore((s) => s.updateElement);
  const [range, setRange] = useState<Range | null>(null);

  const base = baseStyleOf(el);
  const hasRange = range !== null && range.end > range.start;
  const boldOn = hasRange && rangeHasFlag(el.fragments ?? [], el.text, range.start, range.end, "bold", base);
  const italicOn = hasRange && rangeHasFlag(el.fragments ?? [], el.text, range.start, range.end, "italic", base);

  const pickRange = (ta: HTMLTextAreaElement | null) => {
    if (!ta) return;
    setRange({ start: ta.selectionStart, end: ta.selectionEnd });
  };

  const toggle = (flag: "bold" | "italic") => {
    if (!hasRange || !range) return;
    const res = toggleFragmentFlag(
      el.fragments ?? [],
      el.text,
      range.start,
      range.end,
      flag,
      base,
    );
    if (res) updateElement(el.id, { fragments: res.fragments, text: res.text });
  };

  const preview =
    hasRange && range
      ? el.text.slice(range.start, range.end).slice(0, 48)
      : "";

  return (
    <div className="pb-1">
      <div className={panelSectionLabel}>Rich text</div>
      <textarea
        readOnly
        rows={3}
        value={el.text}
        onSelect={(e) => pickRange(e.currentTarget)}
        aria-label="Text content — drag to select a range"
        className={`${inputCls} w-full resize-y font-mono`}
        placeholder="No text"
      />
      {hasRange && range ? (
        <p className="mt-1 text-[11px] leading-snug text-muted">
          Chars {range.start}–{range.end}:{" "}
          <span className="font-medium text-ink">“{preview}”</span>
        </p>
      ) : (
        <p className="mt-1 text-[11px] leading-snug text-muted">
          Drag across the text above to select a range, then style just that range.
        </p>
      )}
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <button
          onClick={() => toggle("bold")}
          disabled={!hasRange}
          className={boldOn ? iconBtnActive : iconBtn}
          title="Bold range"
        >
          <Bold className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() => toggle("italic")}
          disabled={!hasRange}
          className={italicOn ? iconBtnActive : iconBtn}
          title="Italic range"
        >
          <Italic className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() => clearFragments(el.id)}
          disabled={!hasRichFragments(el)}
          className={`${iconBtn} !w-auto gap-1.5 px-2.5 text-[12px]`}
          title="Remove all per-range styling"
        >
          <Eraser className="h-3.5 w-3.5" />
          Clear formatting
        </button>
      </div>
      {hasRange && range && (
        <RangeStyleForm
          key={`${range.start}-${range.end}`}
          el={el}
          range={range}
          onApply={(style) =>
            applyFragmentStyle(el.id, range.start, range.end, style)
          }
        />
      )}
    </div>
  );
}

/** Staged font/size/color controls for the selected range. */
function RangeStyleForm({
  el,
  range,
  onApply,
}: {
  el: TextElement;
  range: Range;
  onApply: (style: {
    fontFamily?: string;
    fontSize?: number;
    fill?: string;
  }) => void;
}) {
  const base = baseStyleOf(el);
  const uniform = rangeUniformStyle(
    el.fragments ?? [],
    el.text,
    range.start,
    range.end,
    base,
  );
  const [fontFamily, setFontFamily] = useState(uniform.fontFamily ?? el.fontFamily);
  const [fontSize, setFontSize] = useState(uniform.fontSize ?? el.fontSize);
  const [fill, setFill] = useState(uniform.fill ?? el.fill);

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
      <select
        value={fontFamily}
        onChange={(e) => setFontFamily(e.target.value)}
        className={`${inputCls} max-w-32 text-[12px]`}
        title="Range font"
        aria-label="Range font"
      >
        {PANEL_FONTS.map((f) => (
          <option key={f.cssFamily} value={f.cssFamily}>
            {f.label}
          </option>
        ))}
      </select>
      <input
        type="number"
        min={8}
        max={400}
        value={fontSize}
        onChange={(e) =>
          setFontSize(Math.min(400, Math.max(8, parseInt(e.target.value, 10) || 8)))
        }
        className={`${inputCls} w-16 text-[12px]`}
        title="Range font size"
        aria-label="Range font size"
      />
      <input
        type="color"
        value={fill}
        onChange={(e) => setFill(e.target.value)}
        className="h-7 w-8 cursor-pointer rounded-key border border-control bg-paper p-0.5"
        title="Range color"
        aria-label="Range color"
      />
      <button
        onClick={() => onApply({ fontFamily, fontSize, fill })}
        className={btnGhost}
      >
        Apply to range
      </button>
    </div>
  );
}

/** FEATURE 1: text-on-a-path presets + custom path data. */
function TextPathControls({ el }: { el: TextElement }) {
  const setTextPath = useCanvasStore((s) => s.setTextPath);
  const [custom, setCustom] = useState(el.textPath ?? "");
  const active = el.textPath ?? "";

  return (
    <div className="pb-1">
      <div className={panelSectionLabel}>Text on a path</div>
      <div className="flex flex-wrap gap-1.5">
        {TEXT_PATH_PRESETS.map((p) => (
          <button
            key={p.key}
            onClick={() => {
              setTextPath(el.id, p.data);
              setCustom(p.data);
            }}
            className={`${btnGhost} !py-1 text-[12px] ${
              active === p.data ? "!border-ink !bg-ink !text-white" : ""
            }`}
            title={`Path preset: ${p.label}`}
          >
            <Spline className="h-3.5 w-3.5" />
            {p.label}
          </button>
        ))}
      </div>
      <div className="mt-1.5 flex gap-1.5">
        <input
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          placeholder="Custom SVG path data…"
          aria-label="Custom SVG path data"
          className={`${inputCls} min-w-0 flex-1 font-mono text-[12px]`}
        />
        <button
          onClick={() => {
            if (custom.trim()) setTextPath(el.id, custom.trim());
          }}
          disabled={!custom.trim()}
          className={btnGhost}
        >
          Set
        </button>
      </div>
      {active && (
        <button
          onClick={() => {
            setTextPath(el.id);
            setCustom("");
          }}
          className={`${btnGhost} mt-1.5 !py-1 text-[12px]`}
        >
          <X className="h-3.5 w-3.5" />
          Remove path
        </button>
      )}
      <p className="mt-1 text-[11px] leading-snug text-muted">
        While a path is set, per-range styling is ignored and the text follows
        the path from the element's position.
      </p>
    </div>
  );
}

export function TextPanel() {
  const document = useCanvasStore((s) => s.document);
  const activePageId = useCanvasStore((s) => s.activePageId);
  const selectedIds = useCanvasStore((s) => s.selectedIds);
  const addElement = useCanvasStore((s) => s.addElement);
  const select = useCanvasStore((s) => s.select);

  const page = document?.pages.find((p) => p.id === activePageId);
  if (!page) return null;

  const selected = page.elements.filter((el) => selectedIds.includes(el.id));
  const singleText =
    selected.length === 1 && selected[0]!.type === "text"
      ? (selected[0] as TextElement)
      : null;

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
      fill: "#1c1917",
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
        {singleText && !singleText.textPath && (
          <RichTextControls
            key={`${singleText.id}:${singleText.text}`}
            el={singleText}
          />
        )}
        {singleText && <TextPathControls key={singleText.id} el={singleText} />}
        <div className={panelSectionLabel}>Presets</div>
        {PRESETS.map((p) => (
          <button
            key={p.label}
            onClick={() => addPreset(p)}
            className="block w-full rounded-md border border-line bg-paper px-3 py-2 text-left hover:border-line-strong hover:bg-hover-paper"
          >
            <span
              className="block truncate text-ink"
              style={{ fontSize: Math.min(p.fontSize, 28), fontWeight: p.fontStyle === "bold" ? 700 : 400, color: p.fill }}
            >
              {p.label}
            </span>
            <span className="text-[11px] text-muted">
              {p.label} · {p.fontSize}px{p.fontStyle === "bold" ? " · bold" : ""}
            </span>
          </button>
        ))}
        <div className={`${panelSectionLabel} pt-2`}>Call to action</div>
        <button
          onClick={addCta}
          className="flex h-control w-full items-center justify-center rounded-full bg-ink px-3 text-[14px] font-semibold text-white aos-press"
        >
          CTA button
        </button>
        <p className="pt-1 text-[11px] leading-snug text-muted">
          Adds a black pill with a centered label as two elements. Select the label to edit its text in the toolbar.
        </p>
      </div>
    </div>
  );
}
