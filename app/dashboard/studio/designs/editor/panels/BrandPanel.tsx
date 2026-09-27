// Marketr — Phase 11 "Canvas": Brand panel. Brand-kit color swatches apply to
// selected elements; fonts feed the text presets. Logos are filesystem paths
// (.data/reports/logos/…) with no public URL route, so insert is skipped with
// an honest note rather than a broken image.

"use client";

import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { useCanvasStore } from "@/lib/design/store";
import { panelSectionLabel, panelTitle } from "../ui";

interface BrandKit {
  id: string;
  name: string;
  colors: Record<string, string>;
  fonts: Record<string, string>;
  logoPath: string | null;
  isDefault: boolean;
}

const COLOR_LABELS: Record<string, string> = {
  primary: "Primary",
  secondary: "Secondary",
  accent: "Accent",
  text: "Text",
  muted: "Muted",
};

function asPatch(el: { type: string }, color: string): Record<string, unknown> {
  // Lines recolor via stroke; everything else with a fill uses fill.
  if (el.type === "line") return { stroke: color };
  if (el.type === "image") return {};
  return { fill: color };
}

export function BrandPanel({ onFontsLoaded }: { onFontsLoaded?: (fonts: string[]) => void }) {
  const [kits, setKits] = useState<BrandKit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState<string | null>(null);

  const document = useCanvasStore((s) => s.document);
  const activePageId = useCanvasStore((s) => s.activePageId);
  const selectedIds = useCanvasStore((s) => s.selectedIds);
  const updateElement = useCanvasStore((s) => s.updateElement);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await fetch("/api/brand-kits");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { brandKits: BrandKit[] };
        if (!live) return;
        setKits(data.brandKits ?? []);
        const fonts = Array.from(
          new Set(
            (data.brandKits ?? []).flatMap((k) => Object.values(k.fonts ?? {})).filter(Boolean)
          )
        );
        onFontsLoaded?.(fonts);
      } catch {
        if (live) setError("Could not load brand kits.");
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const page = document?.pages.find((p) => p.id === activePageId);
  const selected = page?.elements.filter((el) => selectedIds.includes(el.id)) ?? [];

  const applyColor = (kitId: string, key: string, color: string) => {
    if (selected.length === 0) return;
    for (const el of selected) {
      const patch = asPatch(el, color);
      if (Object.keys(patch).length > 0) updateElement(el.id, patch);
    }
    setApplied(`${kitId}:${key}`);
    setTimeout(() => setApplied(null), 1200);
  };

  return (
    <div>
      <div className={panelTitle}>Brand</div>
      <div className="space-y-4 px-3 pb-4">
        {loading && <p className="text-[12px] text-stone-500">Loading brand kits…</p>}
        {error && (
          <p className="rounded-md border border-stone-200 bg-stone-50 px-2.5 py-2 text-[12px] text-stone-600">
            {error}
          </p>
        )}
        {!loading && !error && kits.length === 0 && (
          <p className="text-[12px] leading-snug text-stone-500">
            No brand kits yet. Create one under Brand kits to get one-click colors and fonts here.
          </p>
        )}
        {kits.map((kit) => {
          const colors = Object.entries(kit.colors ?? {}).filter(([, v]) => typeof v === "string" && v);
          const fonts = Object.entries(kit.fonts ?? {}).filter(([, v]) => typeof v === "string" && v);
          return (
            <div key={kit.id} className="rounded-md border border-stone-200 bg-white p-2.5">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-[13px] font-semibold text-stone-900">{kit.name}</span>
                {kit.isDefault && (
                  <span className="rounded-full bg-violet-100 px-1.5 py-0.5 text-[10px] font-medium text-violet-700">
                    Default
                  </span>
                )}
              </div>

              {colors.length > 0 && (
                <div className="pt-2">
                  <div className={panelSectionLabel}>Colors — click to apply</div>
                  <div className="flex flex-wrap gap-1.5">
                    {colors.map(([key, color]) => {
                      const id = `${kit.id}:${key}`;
                      return (
                        <button
                          key={key}
                          onClick={() => applyColor(kit.id, key, color)}
                          disabled={selected.length === 0}
                          title={`${COLOR_LABELS[key] ?? key}: ${color}`}
                          className="relative h-8 w-8 rounded-md border border-stone-200 disabled:opacity-40"
                          style={{ backgroundColor: color }}
                        >
                          {applied === id && (
                            <Check className="absolute inset-0 m-auto h-4 w-4 text-white drop-shadow" />
                          )}
                        </button>
                      );
                    })}
                  </div>
                  {selected.length === 0 && (
                    <p className="pt-1 text-[11px] text-stone-400">Select an element to apply a color.</p>
                  )}
                </div>
              )}

              {fonts.length > 0 && (
                <div className="pt-2">
                  <div className={panelSectionLabel}>Fonts</div>
                  <ul className="space-y-0.5">
                    {fonts.map(([key, font]) => (
                      <li key={key} className="text-[12px] text-stone-600">
                        <span className="capitalize text-stone-400">{key}:</span>{" "}
                        <span style={{ fontFamily: font }}>{font}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="pt-2">
                <div className={panelSectionLabel}>Logo</div>
                {kit.logoPath ? (
                  <p className="text-[11px] leading-snug text-stone-500">
                    Logo is stored server-side (
                    <span className="font-mono">{kit.logoPath}</span>) with no public URL route, so
                    insert is disabled rather than rendering a broken image.
                  </p>
                ) : (
                  <p className="text-[11px] text-stone-400">No logo on this kit.</p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

