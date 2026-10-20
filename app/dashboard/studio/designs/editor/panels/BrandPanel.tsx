// Marketr — Phase 11 "Canvas": Brand panel. Brand-kit color swatches apply to
// selected elements; fonts feed the text presets. Logos are filesystem paths
// (.data/reports/logos/…) with no public URL route, so insert is skipped with
// an honest note rather than a broken image.

"use client";

import { useEffect, useState } from "react";
/* PROVIDER:brandfetch */
import { Check, Globe2, Loader2, Settings, Wand2 } from "lucide-react";
import { btnGhost, btnPrimary, inputCls } from "../ui";
import type { BrandKitImport } from "@/lib/design/brandfetch";
/* END */
/* PROVIDER:penpot */
import { PenpotSection } from "./PenpotSection";
/* END */
/* COLORMIND (integration #10) */
import { Palette } from "lucide-react";
import { colormindStatus } from "@/lib/design/colormind";
/* END */
/* TEXTURES (integration #10) */
import { LayoutGrid } from "lucide-react";
import {
  TEXTURES,
  textureEntryFor,
  withTextureProvenance,
  type TextureEntry,
} from "@/lib/design/textures";
import type { DesignElement } from "@/lib/design/types";
/* END */
import { useCanvasStore } from "@/lib/design/store";
import { panelSectionLabel, panelTitle } from "../ui";

interface BrandKit {
  id: string;
  name: string;
  colors: Record<string, string>;
  fonts: Record<string, string>;
  logoPath: string | null;
  isDefault: boolean;
  /* PROVIDER:brandfetch */
  metadata?: Record<string, unknown> | null;
  /* END */
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

/* COLORMIND (integration #10) — AI palette generation around the brand color.
   FAIL CLOSED (license verification 2026-09-27): Colormind's free API is
   "free for personal and non-commercial use" only (colormind.io/api-access);
   commercial use needs a written agreement with jack@colormind.io. The button
   stays disabled with the honest reason. Kill-switch lives in
   lib/design/colormind.ts; when terms clear, flip it and add per-tenant
   metering in app/api/studio/colormind/generate. */
function ColormindSection({ seedColor }: { seedColor: string | null }) {
  const status = colormindStatus();
  return (
    <div className="rounded-md border border-line bg-paper p-2.5">
      <div className="flex items-center gap-1.5">
        <Palette className="h-4 w-4 text-ink" />
        <span className="text-[0.8125rem] font-semibold text-ink">AI palette</span>
      </div>
      <p className="pt-1 text-[0.6875rem] leading-snug text-muted">
        Generate five harmonious colors around your brand color
        {seedColor ? (
          <>
            {" "}
            (
            <span
              className="inline-block h-3 w-3 rounded-sm border border-line align-[-1px]"
              style={{ backgroundColor: seedColor }}
            />{" "}
            <span className="font-mono">{seedColor}</span>)
          </>
        ) : (
          ""
        )}{" "}
        — then apply the result to the brand kit in one click.
      </p>
      <button
        disabled
        title={status.reason ?? undefined}
        className={`${btnPrimary} mt-2 w-full justify-center`}
      >
        <Palette className="h-4 w-4" />
        Generate palette around our brand color
      </button>
      <p className="pt-1.5 text-[0.625rem] leading-snug text-subtle">{status.reason}</p>
    </div>
  );
}
/* END */

/* TEXTURES (integration #10) — pattern fills/backgrounds from the curated
   ambientCG CC0 set (downloaded and bundled in public/textures/; Transparent
   Textures failed license verification — no license page exists, so it is
   not used). Clicking a thumbnail applies the tile to the page background or
   the selected fillable shapes; provenance lands in the element/page `custom`
   bag (lib/design/textures.ts) and the canvas renders it via fillPatternImage. */
/** Fillable with a pattern tile: rects/ellipses and plain path icons (Iconify
 * icons render from their SVG body and are excluded — patterning them would
 * only re-tint without showing the tile). */
const isFillable = (el: DesignElement): el is DesignElement & { fill: string } =>
  el.type === "rect" || el.type === "ellipse" || (el.type === "svg" && !el.body);

function TexturesSection() {
  const document = useCanvasStore((s) => s.document);
  const activePageId = useCanvasStore((s) => s.activePageId);
  const selectedIds = useCanvasStore((s) => s.selectedIds);
  const updateElement = useCanvasStore((s) => s.updateElement);
  const patchPage = useCanvasStore((s) => s.patchPage);
  const [target, setTarget] = useState<"page" | "shape">("page");

  const page = document?.pages.find((p) => p.id === activePageId);
  const selected = page?.elements.filter((el) => selectedIds.includes(el.id)) ?? [];
  const fillable = selected.filter(isFillable);

  const current =
    target === "page"
      ? textureEntryFor(page?.custom)
      : selected.length === 1
        ? textureEntryFor(selected[0].custom)
        : null;

  const applyTexture = (t: TextureEntry | null) => {
    if (!page) return;
    if (target === "page") {
      patchPage(page.id, { custom: withTextureProvenance(page.custom, t) });
      return;
    }
    for (const el of fillable) {
      updateElement(el.id, {
        ...(t ? { fill: t.baseFill } : {}),
        custom: withTextureProvenance(el.custom, t),
      });
    }
  };

  return (
    <div className="rounded-md border border-line bg-paper p-2.5">
      <div className="flex items-center gap-1.5">
        <LayoutGrid className="h-4 w-4 text-ink" />
        <span className="text-[0.8125rem] font-semibold text-ink">Patterns</span>
        <span className="text-[0.625rem] text-subtle">ambientCG · CC0</span>
      </div>
      <div className="flex gap-1 pt-2">
        {(["page", "shape"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTarget(t)}
            className={
              target === t
                ? "rounded-md bg-ink px-2 py-1 text-[0.6875rem] font-medium text-white"
                : "rounded-md border border-line bg-paper px-2 py-1 text-[0.6875rem] text-muted hover:bg-hover-paper hover:text-ink"
            }
          >
            {t === "page" ? "Page background" : "Selected shape"}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-5 gap-1.5 pt-2">
        {TEXTURES.map((t) => {
          const isCurrent = current?.id === t.id;
          return (
            <button
              key={t.id}
              onClick={() => applyTexture(t)}
              disabled={target === "shape" && fillable.length === 0}
              title={`${t.name} — CC0 via ambientCG`}
              className={`relative overflow-hidden rounded-md border disabled:opacity-40 ${
                isCurrent ? "border-ink ring-1 ring-ink" : "border-line"
              }`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={t.path} alt={t.name} className="h-10 w-full object-cover" />
              {isCurrent && (
                <Check className="absolute right-0.5 top-0.5 h-3.5 w-3.5 text-white drop-shadow" />
              )}
            </button>
          );
        })}
      </div>
      {current ? (
        <div className="flex items-center justify-between pt-1.5">
          <p className="text-[0.6875rem] text-muted">
            Applied: <span className="font-medium text-ink">{current.name}</span>
          </p>
          <button
            onClick={() => applyTexture(null)}
            className="text-[0.6875rem] font-medium text-ink hover:underline"
          >
            Remove
          </button>
        </div>
      ) : (
        target === "shape" &&
        fillable.length === 0 && (
          <p className="pt-1.5 text-[0.6875rem] text-subtle">
            Select a shape (rectangle, ellipse, or a plain path icon) to fill with a pattern.
          </p>
        )
      )}
      <p className="pt-1.5 text-[0.625rem] leading-snug text-subtle">
        Patterns: ambientCG — CC0 1.0, free for commercial use, no attribution required.
      </p>
    </div>
  );
}
/* END */

export function BrandPanel({ onFontsLoaded }: { onFontsLoaded?: (fonts: string[]) => void }) {
  const [kits, setKits] = useState<BrandKit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState<string | null>(null);

  /* PROVIDER:brandfetch */
  const [bfConfigured, setBfConfigured] = useState<boolean | null>(null);
  const [bfDomain, setBfDomain] = useState("");
  const [bfBusy, setBfBusy] = useState(false);
  const [bfError, setBfError] = useState<string | null>(null);
  const [bfResult, setBfResult] = useState<BrandKitImport | null>(null);
  const [bfTarget, setBfTarget] = useState<string>("new");
  const [bfApplying, setBfApplying] = useState(false);
  const [bfDone, setBfDone] = useState<string | null>(null);
  /* END */

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

  /* PROVIDER:brandfetch */
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await fetch("/api/studio/brandfetch/status");
        const json = (await res.json()) as { configured?: boolean };
        if (live) setBfConfigured(res.ok && json.configured === true);
      } catch {
        if (live) setBfConfigured(false);
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const bfRefreshKits = async () => {
    try {
      const res = await fetch("/api/brand-kits");
      if (!res.ok) return;
      const data = (await res.json()) as { brandKits: BrandKit[] };
      setKits(data.brandKits ?? []);
      const fonts = Array.from(
        new Set((data.brandKits ?? []).flatMap((k) => Object.values(k.fonts ?? {})).filter(Boolean))
      );
      onFontsLoaded?.(fonts);
    } catch {
      // Keep the existing list on refresh failure.
    }
  };

  const bfLookup = async () => {
    const d = bfDomain.trim();
    if (!d || bfBusy) return;
    setBfBusy(true);
    setBfError(null);
    setBfResult(null);
    setBfDone(null);
    try {
      const res = await fetch("/api/studio/brandfetch/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain: d }),
      });
      const json = (await res.json()) as BrandKitImport & { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setBfResult({ brand: json.brand, kitColors: json.kitColors ?? {}, kitFonts: json.kitFonts ?? {} });
    } catch (e) {
      setBfError(e instanceof Error ? e.message : "Brand lookup failed.");
    } finally {
      setBfBusy(false);
    }
  };

  const bfApply = async () => {
    if (!bfResult || bfApplying) return;
    setBfApplying(true);
    setBfError(null);
    setBfDone(null);
    try {
      const { brand, kitColors, kitFonts } = bfResult;
      const metadata = {
        source: "brandfetch",
        domain: brand.domain,
        logoUrl: brand.logoUrl,
        fetchedAt: new Date().toISOString(),
      };
      if (bfTarget === "new") {
        const res = await fetch("/api/brand-kits", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: brand.name.slice(0, 120),
            colors: kitColors,
            fonts: kitFonts,
            metadata,
          }),
        });
        const json = (await res.json()) as { error?: string };
        if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
        setBfDone(`Created a “${brand.name}” brand kit from ${brand.domain}.`);
      } else {
        const kit = kits.find((k) => k.id === bfTarget);
        if (!kit) throw new Error("Choose a brand kit first.");
        const res = await fetch(`/api/brand-kits/${bfTarget}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            colors: { ...(kit.colors ?? {}), ...kitColors },
            fonts: { ...(kit.fonts ?? {}), ...kitFonts },
            metadata: { ...(kit.metadata ?? {}), ...metadata },
          }),
        });
        const json = (await res.json()) as { error?: string };
        if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
        setBfDone(`Applied ${brand.domain} to “${kit.name}”.`);
      }
      await bfRefreshKits();
      setBfResult(null);
      setBfDomain("");
    } catch (e) {
      setBfError(e instanceof Error ? e.message : "Could not apply to brand kit.");
    } finally {
      setBfApplying(false);
    }
  };
  /* END */

  /* COLORMIND */
  const defaultKit = kits.find((k) => k.isDefault) ?? kits[0];
  const seedColor = (() => {
    const colors = defaultKit?.colors ?? {};
    const primary = colors.primary;
    if (typeof primary === "string" && primary) return primary;
    const first = Object.values(colors).find((v) => typeof v === "string" && v);
    return typeof first === "string" ? first : null;
  })();
  /* END */

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
        {/* PROVIDER:brandfetch */}
        <div className="rounded-md border border-line bg-paper p-2.5">
          <div className="flex items-center gap-1.5">
            <Globe2 className="h-4 w-4 text-ink" />
            <span className="text-[0.8125rem] font-semibold text-ink">Import from domain</span>
          </div>
          <p className="pt-1 text-[0.6875rem] leading-snug text-muted">
            Paste a client domain to pull their logo, palette, and fonts into a brand kit —
            the agency onboarding shortcut.
          </p>
          {bfConfigured === null ? (
            <p className="flex items-center gap-1.5 pt-2 text-[0.75rem] text-muted">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Checking brand lookup setup…
            </p>
          ) : bfConfigured === false ? (
            <div className="mt-2 rounded-md border border-line bg-canvas px-2.5 py-2">
              <p className="text-[0.75rem] font-medium text-ink">Brand lookup needs a Brandfetch API key</p>
              <p className="pt-0.5 text-[0.6875rem] leading-snug text-muted">
                Add BRANDFETCH_API_KEY in Settings → Providers to enable one-click brand-kit
                autofill. No key, no fake data — this stays off until then.
              </p>
              <a href="/dashboard/settings/providers" className={`${btnGhost} mt-2 inline-flex`}>
                <Settings className="h-4 w-4" />
                Open Providers
              </a>
            </div>
          ) : (
            <>
              <div className="flex gap-1.5 pt-2">
                <input
                  value={bfDomain}
                  onChange={(e) => setBfDomain(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void bfLookup();
                  }}
                  placeholder="stripe.com"
                  className={`${inputCls} min-w-0 flex-1`}
                />
                <button onClick={() => void bfLookup()} disabled={bfBusy || !bfDomain.trim()} className={btnPrimary}>
                  {bfBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
                  Fetch
                </button>
              </div>
              <div className="mt-2 flex gap-1.5 rounded-md border border-line bg-needs-tint px-2.5 py-2">
                <span className="aos-shape aos-shape--needs aos-shape--edged mt-0.5 shrink-0" />
                <p className="text-[0.6875rem] leading-snug text-ink">
                  Third-party logos are trademarked. Only import brands you have the right to
                  use, and check the brand owner's usage guidelines before publishing client
                  work.
                </p>
              </div>
              {bfError && (
                <p className="mt-2 rounded-md border border-failed bg-failed-tint px-2.5 py-2 text-[0.75rem] text-failed-text">
                  {bfError}
                </p>
              )}
              {bfResult && (
                <div className="mt-2 rounded-md border border-line bg-paper p-2.5">
                  <div className="flex items-center gap-2">
                    {bfResult.brand.logoUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={bfResult.brand.logoUrl}
                        alt={`${bfResult.brand.name} logo`}
                        className="h-10 w-10 shrink-0 rounded object-contain"
                      />
                    ) : (
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-canvas text-[0.625rem] text-subtle">
                        No logo
                      </div>
                    )}
                    <div className="min-w-0">
                      <p className="truncate text-[0.8125rem] font-semibold text-ink">{bfResult.brand.name}</p>
                      <p className="truncate font-mono text-[0.6875rem] text-subtle">{bfResult.brand.domain}</p>
                    </div>
                  </div>
                  {Object.keys(bfResult.kitColors).length > 0 && (
                    <div className="pt-2">
                      <div className={panelSectionLabel}>Palette — from Brandfetch</div>
                      <div className="flex flex-wrap gap-1.5">
                        {Object.entries(bfResult.kitColors).map(([key, color]) => (
                          <span
                            key={key}
                            title={`${key}: ${color}`}
                            className="h-8 w-8 rounded-md border border-line"
                            style={{ backgroundColor: color }}
                          />
                        ))}
                      </div>
                    </div>
                  )}
                  {Object.keys(bfResult.kitFonts).length > 0 && (
                    <div className="pt-2">
                      <div className={panelSectionLabel}>Fonts — from Brandfetch</div>
                      <ul className="space-y-0.5">
                        {Object.entries(bfResult.kitFonts).map(([key, font]) => (
                          <li key={key} className="text-[0.75rem] text-muted">
                            <span className="capitalize text-subtle">{key}:</span>{" "}
                            <span style={{ fontFamily: font }}>{font}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <div className="flex gap-1.5 pt-2">
                    <select
                      value={bfTarget}
                      onChange={(e) => setBfTarget(e.target.value)}
                      className={`${inputCls} min-w-0 flex-1`}
                    >
                      <option value="new">New brand kit</option>
                      {kits.map((k) => (
                        <option key={k.id} value={k.id}>
                          {k.name}
                        </option>
                      ))}
                    </select>
                    <button onClick={() => void bfApply()} disabled={bfApplying} className={btnPrimary}>
                      {bfApplying ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                      Apply to brand kit
                    </button>
                  </div>
                </div>
              )}
              {bfDone && <p className="flex items-center gap-1 pt-1.5 text-[0.6875rem] font-medium text-ink"><Check className="h-3.5 w-3.5 shrink-0" />{bfDone}</p>}
            </>
          )}
        </div>
        {/* END */}
        {/* PROVIDER:penpot */}
        <PenpotSection kits={kits} onKitsChanged={bfRefreshKits} />
        {/* END */}
        {loading && <p className="text-[0.75rem] text-muted">Loading brand kits…</p>}
        {error && (
          <p className="rounded-md border border-failed bg-failed-tint px-2.5 py-2 text-[0.75rem] text-failed-text">
            {error}
          </p>
        )}
        {!loading && !error && kits.length === 0 && (
          <p className="text-[0.75rem] leading-snug text-muted">
            No brand kits yet. Create one under Brand kits to get one-click colors and fonts here.
          </p>
        )}
        {kits.map((kit) => {
          const colors = Object.entries(kit.colors ?? {}).filter(([, v]) => typeof v === "string" && v);
          const fonts = Object.entries(kit.fonts ?? {}).filter(([, v]) => typeof v === "string" && v);
          return (
            <div key={kit.id} className="rounded-md border border-line bg-paper p-2.5">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-[0.8125rem] font-semibold text-ink">{kit.name}</span>
                {kit.isDefault && (
                  <span className="rounded-full bg-canvas px-1.5 py-0.5 text-[0.625rem] font-medium text-muted">
                    Default
                  </span>
                )}
              </div>
              {/* PROVIDER:brandfetch */}
              {kit.metadata?.source === "brandfetch" && (
                <p className="pt-0.5 text-[0.6875rem] text-subtle">
                  Imported from{" "}
                  <span className="font-mono">{String(kit.metadata.domain ?? "")}</span>
                </p>
              )}
              {/* END */}
              {/* PROVIDER:penpot */}
              {kit.metadata?.source === "penpot" && (
                <p className="pt-0.5 text-[0.6875rem] text-subtle">
                  Imported from Penpot
                  {kit.metadata.fileName ? (
                    <>
                      {" "}· <span className="font-mono">{String(kit.metadata.fileName).slice(0, 60)}</span>
                    </>
                  ) : null}
                </p>
              )}
              {/* END */}

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
                          className="relative h-8 w-8 rounded-md border border-line disabled:opacity-40"
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
                    <p className="pt-1 text-[0.6875rem] text-subtle">Select an element to apply a color.</p>
                  )}
                </div>
              )}

              {fonts.length > 0 && (
                <div className="pt-2">
                  <div className={panelSectionLabel}>Fonts</div>
                  <ul className="space-y-0.5">
                    {fonts.map(([key, font]) => (
                      <li key={key} className="text-[0.75rem] text-muted">
                        <span className="capitalize text-subtle">{key}:</span>{" "}
                        <span style={{ fontFamily: font }}>{font}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="pt-2">
                <div className={panelSectionLabel}>Logo</div>
                {kit.logoPath ? (
                  <p className="text-[0.6875rem] leading-snug text-muted">
                    Logo is stored server-side (
                    <span className="font-mono">{kit.logoPath}</span>) with no public URL route, so
                    insert is disabled rather than rendering a broken image.
                  </p>
                ) : (
                  <p className="text-[0.6875rem] text-subtle">No logo on this kit.</p>
                )}
              </div>
            </div>
          );
        })}
        {/* COLORMIND (integration #10) */}
        <ColormindSection seedColor={seedColor} />
        {/* END */}
        {/* TEXTURES (integration #10) */}
        <TexturesSection />
        {/* END */}
      </div>
    </div>
  );
}

