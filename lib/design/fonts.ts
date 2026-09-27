// Marketr — Phase 11 "Canvas", integration #4: self-hosted brand fonts.
//
// Fontsource (npm, version-pinned, same-origin) is the primary pipeline — the
// Google Fonts CSS API is NOT in the default path (privacy/GDPR IP-leakage +
// non-deterministic upstream updates). OFL-1.1 families only.
//
// License verification: every family below was checked 2026-09-27 against the
// keyless Fontsource catalog API (api.fontsource.org/v1/fonts/<id>), which
// reported "license": "OFL-1.1" for all 16. Never add a family whose license
// you cannot confirm — see the `license` field contract enforced in
// __tests__/fonts.test.ts.
//
// Bundle discipline: variable fonts ship latin(+latin-ext where the package
// bundles it) only; woff2 files are fetched by the browser lazily on first
// use (unicode-range + font-display:swap), so the 1.1MB of font files costs
// ~0 bytes until a family is actually rendered. Italic variable axes are NOT
// bundled — they lazy-load at runtime through `ensureFontLoaded`.
//
// ── CRITICAL KONVA RULE ───────────────────────────────────────────────
// Canvas rasterization uses whatever font is loaded AT DRAW TIME. Every
// render/export path MUST `await awaitFontsReady(doc)` before rasterizing
// (stage.toDataURL / jsPDF / SVG serialize), otherwise text silently renders
// in a fallback font and exports lie. The gate never throws: it resolves
// with the list of families that failed so the UI can warn honestly.

import type { DesignDocument, TextElement } from "./types";

export type FontCategory = "sans" | "serif" | "display" | "mono";
export type FontLoadStyle = "normal" | "italic";

export interface CuratedFont {
  /** Fontsource id, e.g. "space-grotesk". */
  id: string;
  /** Display label, e.g. "Space Grotesk". */
  label: string;
  /**
   * The CSS font-family name actually registered by the Fontsource package.
   * Variable packages register "<Family> Variable" — this is the string that
   * must go into element.fontFamily / canvas font strings.
   */
  cssFamily: string;
  category: FontCategory;
  variable: boolean;
  /** Weights the gate probes. Variable fonts: representative [400, 700]. */
  probeWeights: number[];
  /** Human-readable weight coverage for the picker. */
  weightsLabel: string;
  /** True italic faces available (not synthesized oblique). */
  italic: boolean;
  /** License contract: OFL-1.1 or Apache-2.0 only. Nothing else ships. */
  license: "OFL-1.1" | "Apache-2.0";
  licenseUrl: string;
  npmPackage: string;
  /** Bundled via a Fontsource CSS import (true) or runtime-lazy only. */
  shipped: boolean;
}

const OFL_URL = "https://scripts.sil.org/OFL";

export const FONT_REGISTRY: CuratedFont[] = [
  // ── Sans ──────────────────────────────────────────────────────────
  { id: "inter", label: "Inter", cssFamily: "Inter", category: "sans", variable: false, probeWeights: [400, 700], weightsLabel: "400 · 500 · 600 · 700", italic: false, license: "OFL-1.1", licenseUrl: OFL_URL, npmPackage: "@fontsource/inter", shipped: true },
  { id: "space-grotesk", label: "Space Grotesk", cssFamily: "Space Grotesk Variable", category: "sans", variable: true, probeWeights: [400, 700], weightsLabel: "100–700 variable", italic: false, license: "OFL-1.1", licenseUrl: OFL_URL, npmPackage: "@fontsource-variable/space-grotesk", shipped: true },
  { id: "sora", label: "Sora", cssFamily: "Sora Variable", category: "sans", variable: true, probeWeights: [400, 700], weightsLabel: "100–800 variable", italic: false, license: "OFL-1.1", licenseUrl: OFL_URL, npmPackage: "@fontsource-variable/sora", shipped: true },
  { id: "dm-sans", label: "DM Sans", cssFamily: "DM Sans Variable", category: "sans", variable: true, probeWeights: [400, 700], weightsLabel: "100–900 variable", italic: true, license: "OFL-1.1", licenseUrl: OFL_URL, npmPackage: "@fontsource-variable/dm-sans", shipped: true },
  { id: "manrope", label: "Manrope", cssFamily: "Manrope Variable", category: "sans", variable: true, probeWeights: [400, 700], weightsLabel: "200–800 variable", italic: false, license: "OFL-1.1", licenseUrl: OFL_URL, npmPackage: "@fontsource-variable/manrope", shipped: true },
  { id: "outfit", label: "Outfit", cssFamily: "Outfit Variable", category: "sans", variable: true, probeWeights: [400, 700], weightsLabel: "100–900 variable", italic: false, license: "OFL-1.1", licenseUrl: OFL_URL, npmPackage: "@fontsource-variable/outfit", shipped: true },
  { id: "work-sans", label: "Work Sans", cssFamily: "Work Sans Variable", category: "sans", variable: true, probeWeights: [400, 700], weightsLabel: "100–900 variable", italic: true, license: "OFL-1.1", licenseUrl: OFL_URL, npmPackage: "@fontsource-variable/work-sans", shipped: true },
  { id: "libre-franklin", label: "Libre Franklin", cssFamily: "Libre Franklin Variable", category: "sans", variable: true, probeWeights: [400, 700], weightsLabel: "100–900 variable", italic: true, license: "OFL-1.1", licenseUrl: OFL_URL, npmPackage: "@fontsource-variable/libre-franklin", shipped: true },
  { id: "archivo", label: "Archivo", cssFamily: "Archivo Variable", category: "sans", variable: true, probeWeights: [400, 700], weightsLabel: "100–900 variable", italic: true, license: "OFL-1.1", licenseUrl: OFL_URL, npmPackage: "@fontsource-variable/archivo", shipped: true },
  { id: "ibm-plex-sans", label: "IBM Plex Sans", cssFamily: "IBM Plex Sans Variable", category: "sans", variable: true, probeWeights: [400, 700], weightsLabel: "100–700 variable", italic: true, license: "OFL-1.1", licenseUrl: OFL_URL, npmPackage: "@fontsource-variable/ibm-plex-sans", shipped: true },
  // ── Serif ─────────────────────────────────────────────────────────
  { id: "playfair-display", label: "Playfair Display", cssFamily: "Playfair Display Variable", category: "serif", variable: true, probeWeights: [400, 700], weightsLabel: "400–900 variable", italic: true, license: "OFL-1.1", licenseUrl: OFL_URL, npmPackage: "@fontsource-variable/playfair-display", shipped: true },
  { id: "dm-serif-display", label: "DM Serif Display", cssFamily: "DM Serif Display", category: "serif", variable: false, probeWeights: [400], weightsLabel: "400 + italic", italic: true, license: "OFL-1.1", licenseUrl: OFL_URL, npmPackage: "@fontsource/dm-serif-display", shipped: true },
  { id: "instrument-serif", label: "Instrument Serif", cssFamily: "Instrument Serif", category: "serif", variable: false, probeWeights: [400], weightsLabel: "400 + italic", italic: true, license: "OFL-1.1", licenseUrl: OFL_URL, npmPackage: "@fontsource/instrument-serif", shipped: true },
  // ── Display ───────────────────────────────────────────────────────
  { id: "bebas-neue", label: "Bebas Neue", cssFamily: "Bebas Neue", category: "display", variable: false, probeWeights: [400], weightsLabel: "400", italic: false, license: "OFL-1.1", licenseUrl: OFL_URL, npmPackage: "@fontsource/bebas-neue", shipped: true },
  { id: "bricolage-grotesque", label: "Bricolage Grotesque", cssFamily: "Bricolage Grotesque Variable", category: "display", variable: true, probeWeights: [400, 700], weightsLabel: "200–800 variable", italic: false, license: "OFL-1.1", licenseUrl: OFL_URL, npmPackage: "@fontsource-variable/bricolage-grotesque", shipped: true },
  // ── Mono ──────────────────────────────────────────────────────────
  { id: "ibm-plex-mono", label: "IBM Plex Mono", cssFamily: "IBM Plex Mono", category: "mono", variable: false, probeWeights: [400, 500, 600], weightsLabel: "400 · 500 · 600", italic: false, license: "OFL-1.1", licenseUrl: OFL_URL, npmPackage: "@fontsource/ibm-plex-mono", shipped: true },
];

export const FONT_CATEGORIES: { key: FontCategory; label: string }[] = [
  { key: "sans", label: "Sans" },
  { key: "serif", label: "Serif" },
  { key: "display", label: "Display" },
  { key: "mono", label: "Monospace" },
];

/** System fallbacks kept for legacy documents (not curated, not shipped). */
export const SYSTEM_FONTS = [
  "Arial",
  "Helvetica",
  "Georgia",
  "Times New Roman",
  "Courier New",
  "Verdana",
  "Trebuchet MS",
] as const;

const byId = new Map(FONT_REGISTRY.map((f) => [f.id, f]));
const byCss = new Map(FONT_REGISTRY.map((f) => [normalize(f.cssFamily), f]));
const byLabel = new Map(FONT_REGISTRY.map((f) => [normalize(f.label), f]));

function normalize(name: string): string {
  return name.trim().toLowerCase().replace(/^["']|["']$/g, "");
}

/**
 * Resolve any font-family reference (registry id, CSS family incl. the
 * " Variable" suffix, display label, or brand-kit value) to its registry
 * entry. Returns undefined for system fonts and unknown families.
 */
export function findFont(name: string | null | undefined): CuratedFont | undefined {
  if (!name) return undefined;
  const n = normalize(name);
  return (
    byId.get(n) ??
    byCss.get(n) ??
    byLabel.get(n) ??
    byCss.get(n.replace(/\s+variable$/, "")) ??
    byLabel.get(n.replace(/\s+variable$/, ""))
  );
}

/** The CSS family string to actually use for a font reference. */
export function cssFamilyOf(name: string): string {
  return findFont(name)?.cssFamily ?? name;
}

// ── Loader ──────────────────────────────────────────────────────────────

const FONTSOURCE_API = "https://api.fontsource.org/v1/fonts";
const JSDELIVR_FONTS = "https://cdn.jsdelivr.net/fontsource/fonts";

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

function fontsApi(): FontFaceSet | undefined {
  if (typeof document === "undefined") return undefined;
  const d = document as Document & { fonts?: FontFaceSet };
  return d.fonts;
}

function probeLoaded(cssFamily: string, weight: number, style: FontLoadStyle): boolean {
  const fonts = fontsApi();
  if (!fonts) return false;
  try {
    // check() does not trigger a fetch — true means usable right now.
    return fonts.check(`${style} ${weight} 16px "${cssFamily}"`, "Ag");
  } catch {
    return false;
  }
}

function kebab(label: string): string {
  return label
    .toLowerCase()
    .replace(/\s+variable$/, "")
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

interface FontsourceVariantFile {
  url?: { woff2?: string };
}
interface FontsourceMeta {
  npmVersion?: string;
  defSubset?: string;
  variants?: Record<string, Record<string, Record<string, FontsourceVariantFile>>>;
}

async function fontsourceFileUrl(id: string, weight: number, style: FontLoadStyle): Promise<string | null> {
  try {
    const res = await withTimeout(
      fetch(`${FONTSOURCE_API}/${encodeURIComponent(id)}`),
      8000,
      "fontsource api",
    );
    if (!res.ok) return null;
    const meta = (await res.json()) as FontsourceMeta;
    const v = meta.variants?.[String(weight)]?.[style];
    const file =
      v?.["latin"]?.url?.woff2 ?? (meta.defSubset ? v?.[meta.defSubset]?.url?.woff2 : undefined);
    if (!file) return null;
    // Pin @latest to the catalog's npm version for deterministic URLs.
    return meta.npmVersion ? file.replace("@latest", `@${meta.npmVersion}`) : file;
  } catch {
    return null;
  }
}

/**
 * Lazy-load a single weight/style of a family that is not bundled, via the
 * keyless Fontsource API with a versioned jsDelivr woff2 URL as fallback.
 * Returns true when the face is usable via document.fonts.
 */
async function lazyLoadFace(
  cssFamily: string,
  id: string,
  weight: number,
  style: FontLoadStyle,
): Promise<boolean> {
  const fonts = fontsApi();
  if (!fonts || typeof FontFace === "undefined") return false;
  const apiUrl = await fontsourceFileUrl(id, weight, style);
  const url =
    apiUrl ?? `${JSDELIVR_FONTS}/${id}@latest/latin-${weight}-${style}.woff2`;
  try {
    const face = new FontFace(cssFamily, `url("${url}") format("woff2")`, {
      weight: String(weight),
      style,
    });
    await withTimeout(face.load(), 10000, "fontface load");
    fonts.add(face);
    return probeLoaded(cssFamily, weight, style);
  } catch {
    return false;
  }
}

const inflight = new Map<string, Promise<boolean>>();

/**
 * Ensure one weight/style of a family is usable for canvas rendering.
 * Resolution order: already loaded → bundled @font-face (force load) →
 * keyless Fontsource API + FontFace → versioned jsDelivr fallback.
 * Never throws; returns false when the family cannot be made available
 * (caller falls back to the previous family and the export gate reports it).
 */
export async function ensureFontLoaded(
  family: string,
  opts: { weight?: number; style?: FontLoadStyle } = {},
): Promise<boolean> {
  const entry = findFont(family);
  const css = entry?.cssFamily ?? family.trim();
  if (!css) return false;
  const weight = opts.weight ?? 400;
  const style = opts.style ?? "normal";
  const key = `${css}|${weight}|${style}`;

  if (probeLoaded(css, weight, style)) return true;
  const cached = inflight.get(key);
  if (cached) return cached;

  const run = (async (): Promise<boolean> => {
    try {
      const fonts = fontsApi();
      if (fonts) {
        // Bundled families: the @font-face rules are already in the page —
        // load() triggers the fetch for the needed subset.
        try {
          await withTimeout(
            fonts.load(`${style} ${weight} 16px "${css}"`, "Ag"),
            8000,
            "fonts.load",
          );
        } catch {
          // load() rejecting just means "not available that way" — fall through.
        }
        if (probeLoaded(css, weight, style)) return true;
      }
      // Not bundled (or bundled load missed, e.g. an italic variable axis we
      // deliberately did not ship): fetch the woff2 at runtime.
      const id = entry?.id ?? kebab(css);
      return await lazyLoadFace(css, id, weight, style);
    } catch {
      return false;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, run);
  return run;
}

// ── Export gate ─────────────────────────────────────────────────────────

export interface UsedFont {
  family: string;
  weight: number;
  style: FontLoadStyle;
}

function weightOf(fontStyle: TextElement["fontStyle"]): number {
  return fontStyle === "bold" || fontStyle === "bold-italic" ? 700 : 400;
}

function styleOf(fontStyle: TextElement["fontStyle"]): FontLoadStyle {
  return fontStyle === "italic" || fontStyle === "bold-italic" ? "italic" : "normal";
}

/**
 * Collect every (family, weight, style) a document needs for faithful
 * rendering: text elements + rich-text fragments + chart labels (Inter).
 * Families are returned as stored on the elements (resolve via findFont /
 * cssFamilyOf at load time).
 */
export function fontsUsedInDocument(doc: DesignDocument): UsedFont[] {
  const seen = new Map<string, UsedFont>();
  const add = (family: unknown, weight: number, style: FontLoadStyle) => {
    if (typeof family !== "string" || !family.trim()) return;
    const f = family.trim();
    const k = `${f}|${weight}|${style}`;
    if (!seen.has(k)) seen.set(k, { family: f, weight, style });
  };
  for (const page of doc.pages ?? []) {
    for (const el of page.elements ?? []) {
      if (el.type === "text") {
        add(el.fontFamily, weightOf(el.fontStyle), styleOf(el.fontStyle));
        for (const frag of el.fragments ?? []) {
          add(
            frag.fontFamily ?? el.fontFamily,
            weightOf(frag.fontStyle ?? el.fontStyle),
            styleOf(frag.fontStyle ?? el.fontStyle),
          );
        }
      } else if (el.type === "chart") {
        // lib/design/export-svg.ts renders chart labels in Inter.
        add("Inter", 400, "normal");
        add("Inter", 700, "normal");
      }
    }
  }
  return [...seen.values()];
}

export interface FontsReadyResult {
  ready: boolean;
  /** Display labels of families that could not be made available. */
  missing: string[];
}

/**
 * THE export gate. Await before every rasterize (PNG/JPG/PDF) and before SVG
 * serialize: forces every family/weight/style the document uses into
 * document.fonts, so Konva draws with the real fonts instead of silent
 * fallbacks. Never throws — resolves with `missing` for an honest UI warning.
 */
export async function awaitFontsReady(
  doc: DesignDocument,
  opts: { timeoutMs?: number } = {},
): Promise<FontsReadyResult> {
  const timeoutMs = opts.timeoutMs ?? 12000;
  try {
    const fonts = fontsApi();
    if (!fonts) return { ready: true, missing: [] }; // SSR: no browser fonts.
    try {
      await withTimeout(Promise.resolve(fonts.ready), timeoutMs, "fonts.ready");
    } catch {
      // Continue anyway — per-family loads still get their own attempts.
    }
    const used = fontsUsedInDocument(doc);
    const missing = new Set<string>();
    await Promise.all(
      used.map(async (u) => {
        const ok = await ensureFontLoaded(u.family, { weight: u.weight, style: u.style });
        if (!ok) missing.add(findFont(u.family)?.label ?? u.family);
      }),
    );
    return { ready: missing.size === 0, missing: [...missing] };
  } catch {
    return { ready: false, missing: [] };
  }
}

/** Compact { label, cssFamily } list for inline font <select>s (curated + system fallbacks). */
export const PANEL_FONTS: { label: string; cssFamily: string }[] = [
  ...FONT_REGISTRY.map((f) => ({ label: f.label, cssFamily: f.cssFamily })),
  ...SYSTEM_FONTS.map((f) => ({ label: f, cssFamily: f })),
];
