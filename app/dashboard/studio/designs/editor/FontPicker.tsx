// Marketr — Phase 11 "Canvas", integration #4: curated font picker.
// Grouped by category with a live in-family preview of every row. Selecting a
// family awaits ensureFontLoaded first (fonts.ts) so Konva never draws with a
// silent fallback; the caller then forces a layer redraw.

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Search, Type } from "lucide-react";
import {
  FONT_CATEGORIES,
  FONT_REGISTRY,
  SYSTEM_FONTS,
  ensureFontLoaded,
  findFont,
  type CuratedFont,
} from "@/lib/design/fonts";

interface FontOption {
  key: string;
  label: string;
  cssFamily: string;
  sub: string;
  entry?: CuratedFont;
}

interface FontPickerProps {
  value: string;
  onChange: (cssFamily: string) => void;
  /** Extra families from brand kits, shown in their own group. */
  brandFonts?: string[];
  className?: string;
  ariaLabel?: string;
}

function brandOptions(brandFonts: string[]): FontOption[] {
  const seen = new Set<string>();
  const out: FontOption[] = [];
  for (const raw of brandFonts) {
    const name = raw.trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const entry = findFont(name);
    out.push({
      key: `brand:${name}`,
      label: entry?.label ?? name,
      cssFamily: entry?.cssFamily ?? name,
      sub: entry ? "Brand kit · curated" : "Brand kit",
      entry,
    });
  }
  return out;
}

export function FontPicker({ value, onChange, brandFonts = [], className = "", ariaLabel = "Font family" }: FontPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  // Warm the bundled families when the picker opens so every row previews in
  // its real face. DOM text repaints automatically as each face arrives.
  useEffect(() => {
    if (!open) return;
    for (const f of FONT_REGISTRY) void ensureFontLoaded(f.cssFamily);
  }, [open ]);

  const current = findFont(value);
  const currentLabel = current?.label ?? value;
  const currentCss = current?.cssFamily ?? value;

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (o: FontOption) => !q || o.label.toLowerCase().includes(q) || o.cssFamily.toLowerCase().includes(q);
    const list: { title: string; options: FontOption[] }[] = [];
    const brand = brandOptions(brandFonts).filter(match);
    if (brand.length > 0) list.push({ title: "Brand", options: brand });
    for (const cat of FONT_CATEGORIES) {
      const options = FONT_REGISTRY.filter((f) => f.category === cat.key)
        .map((f) => ({
          key: f.id,
          label: f.label,
          cssFamily: f.cssFamily,
          sub: f.weightsLabel,
          entry: f,
        }))
        .filter(match);
      if (options.length > 0) list.push({ title: cat.label, options });
    }
    const system = SYSTEM_FONTS.filter((s) => !findFont(s))
      .map((s) => ({ key: `sys:${s}`, label: s, cssFamily: s, sub: "System" }))
      .filter(match);
    if (system.length > 0) list.push({ title: "System", options: system });
    return list;
  }, [query, brandFonts]);

  const pick = (opt: FontOption) => {
    setOpen(false);
    setQuery("");
    if (opt.cssFamily !== value && opt.cssFamily !== currentCss) onChange(opt.cssFamily);
  };

  return (
    <div ref={ref} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={ariaLabel}
        title={ariaLabel}
        className="flex max-w-44 items-center gap-1.5 rounded-md border border-stone-200 bg-white px-2 py-1 text-[12px] text-stone-700 hover:border-violet-400"
      >
        <Type className="h-3.5 w-3.5 shrink-0 text-stone-400" />
        <span className="truncate" style={{ fontFamily: `"${currentCss}", sans-serif` }}>
          {currentLabel}
        </span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-stone-400" />
      </button>
      {open && (
        <div className="absolute left-0 z-30 mt-1 w-64 overflow-hidden rounded-md border border-stone-200 bg-white shadow-lg">
          <div className="border-b border-stone-100 p-1.5">
            <div className="flex items-center gap-1.5 rounded-md bg-stone-50 px-2 py-1">
              <Search className="h-3.5 w-3.5 shrink-0 text-stone-400" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search fonts…"
                aria-label="Search fonts"
                className="w-full bg-transparent text-[12px] text-stone-700 outline-none placeholder:text-stone-400"
              />
            </div>
          </div>
          <div className="max-h-80 overflow-y-auto py-1">
            {groups.length === 0 && (
              <p className="px-3 py-4 text-[12px] text-stone-400">No fonts match “{query}”.</p>
            )}
            {groups.map((g) => (
              <div key={g.title}>
                <p className="px-3 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wide text-stone-400">
                  {g.title}
                </p>
                {g.options.map((opt) => {
                  const active = opt.cssFamily === currentCss || opt.cssFamily === value;
                  return (
                    <button
                      key={opt.key}
                      type="button"
                      onClick={() => pick(opt)}
                      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-violet-50/40 ${
                        active ? "bg-violet-50/60" : ""
                      }`}
                      title={`${opt.label} — ${opt.sub}`}
                    >
                      <span
                        className="flex-1 truncate text-[15px] leading-snug text-stone-800"
                        style={{ fontFamily: `"${opt.cssFamily}", sans-serif` }}
                      >
                        {opt.label}
                      </span>
                      <span className="shrink-0 text-[10px] text-stone-400">{opt.sub}</span>
                      {active && <Check className="h-3.5 w-3.5 shrink-0 text-violet-600" />}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
          <p className="border-t border-stone-100 px-3 py-1.5 text-[10px] leading-snug text-stone-400">
            All families are OFL-licensed and self-hosted — safe for client exports.
          </p>
        </div>
      )}
    </div>
  );
}
