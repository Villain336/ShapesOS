// Marketr — Phase 5 A1: chat-generated QR styling engine (Creative Studio).
//
// The styling layer touches ARTWORK ONLY — never the encoded data. The QR
// matrix is generated from the target URL by the `qrcode` library (error
// correction forced to H for styled codes); every style is then applied to
// that real matrix, pixel-validated, and scan-tested with a real decoder
// (jsqr) before anything is previewed, print-locked, or bound into a
// per-buy approval object.
//
// Deterministic by default: procedural glyphs work with no LLM key. In
// production the chat LLM implements QrGlyphLlm and its SVG path is parsed
// and measured here — the artwork contract is the same either way.

import { createHash } from "crypto";
import QRCode from "qrcode";
import { PNG } from "pngjs";
import jsQR from "jsqr";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ModuleGlyphKind = "square" | "rounded" | "dots" | "custom-svg";
export type ShapeMask = "square" | "round";
/** Finders are stylable ONLY as solid or rounded — position squares stay. */
export type FinderStyle = "solid" | "rounded";

export interface Pt {
  x: number;
  y: number;
}

/**
 * A designed module glyph: one or more closed polygons in unit-cell coords
 * (0..1). A dark module is drawn by filling the glyph polygons; fillFraction
 * is the estimated fraction of the cell covered (used by validation).
 */
export interface GlyphDesign {
  kind: ModuleGlyphKind;
  label: string;
  /** Closed polygons in unit-cell coordinates. */
  polys: Pt[][];
  /** SVG path data (unit-cell viewBox 0 0 1 1) — set for custom-svg glyphs. */
  customSvgPath?: string;
  /** Estimated fraction of a dark cell the glyph covers (0..1). */
  fillFraction: number;
  /** Narrowest feature of the glyph, in cell units. */
  minFeatureWidth: number;
}

export interface QrStyleSpec {
  moduleGlyph: ModuleGlyphKind;
  /** SVG path for custom-svg glyphs (unit-cell viewBox 0 0 1 1). */
  customGlyphSvg?: string;
  /** Human label of the glyph ("little snakes"). */
  glyphLabel: string;
  shapeMask: ShapeMask;
  foreground: string;
  background: string;
  finderStyle: FinderStyle;
  /** Decoded PNG bytes of the center logo (null = none). */
  logoImagePng: Buffer | null;
  frameCta: string | null;
  /** Forced for styled codes (spec §A1). */
  errorCorrection: "H";
  quietZoneModules: number;
  fillFraction: number;
}

export interface QrStyleIntent {
  glyphHint: string;
  shapeMask: ShapeMask;
  foreground?: string;
  background?: string;
  frameCta?: string;
  logoDataUrl?: string;
}

export interface BrandContext {
  foreground?: string;
  background?: string;
  logoDataUrl?: string;
  name?: string;
}

/** Production LLM interface: the chat model designs an SVG module glyph. */
export interface QrGlyphLlm {
  designGlyph(description: string): Promise<{
    svgPath: string;
    label: string;
    /** Declared fill fraction (measured here as a cross-check). */
    fillFraction: number;
    minFeatureWidth: number;
  }>;
}

export class QrDesignerError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "QrDesignerError";
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Color utils
// ---------------------------------------------------------------------------

const NAMED_COLORS: Record<string, string> = {
  black: "#000000",
  white: "#FFFFFF",
  red: "#E11D48",
  blue: "#2563EB",
  navy: "#1E3A8A",
  green: "#16A34A",
  purple: "#7C3AED",
  violet: "#7C3AED",
  orange: "#EA580C",
  gold: "#B45309",
  yellow: "#EAB308",
  teal: "#0D9488",
  pink: "#DB2777",
  gray: "#6B7280",
  grey: "#6B7280",
};

export function normalizeHexColor(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  if (NAMED_COLORS[s]) return NAMED_COLORS[s];
  let h = s.startsWith("#") ? s.slice(1) : s;
  if (/^[0-9a-f]{3}$/.test(h)) h = h.split("").map((c) => c + c).join("");
  if (!/^[0-9a-f]{6}$/.test(h)) return null;
  return "#" + h.toUpperCase();
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = normalizeHexColor(hex) ?? "#000000";
  return {
    r: parseInt(h.slice(1, 3), 16),
    g: parseInt(h.slice(3, 5), 16),
    b: parseInt(h.slice(5, 7), 16),
  };
}

function channelLum(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance. */
export function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  return 0.2126 * channelLum(r) + 0.7152 * channelLum(g) + 0.0722 * channelLum(b);
}

/** WCAG contrast ratio between two hex colors. */
export function contrastRatio(fg: string, bg: string): number {
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

// ---------------------------------------------------------------------------
// Polygon utils (unit-cell geometry)
// ---------------------------------------------------------------------------

export function pointInPolygon(px: number, py: number, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const yi = poly[i].y;
    const xj = poly[j].x;
    const yj = poly[j].y;
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** True when the point is inside ANY of the glyph's polygons. */
export function pointInGlyph(px: number, py: number, polys: Pt[][]): boolean {
  return polys.some((p) => pointInPolygon(px, py, p));
}

/** Estimated union fill fraction of polygons inside the unit cell. */
export function measureFillFraction(polys: Pt[][], samples = 48): number {
  let inside = 0;
  const total = samples * samples;
  for (let iy = 0; iy < samples; iy++) {
    for (let ix = 0; ix < samples; ix++) {
      if (pointInGlyph((ix + 0.5) / samples, (iy + 0.5) / samples, polys)) inside++;
    }
  }
  return inside / total;
}

function circlePoly(cx: number, cy: number, r: number, steps = 48): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i < steps; i++) {
    const a = (2 * Math.PI * i) / steps;
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return pts;
}

function roundedRectPoly(inset: number, radius: number, steps = 8): Pt[] {
  const x0 = inset;
  const y0 = inset;
  const x1 = 1 - inset;
  const y1 = 1 - inset;
  const r = Math.min(radius, (x1 - x0) / 2, (y1 - y0) / 2);
  const pts: Pt[] = [];
  const corners: Array<[number, number, number]> = [
    [x1 - r, y0 + r, -Math.PI / 2], // top-right
    [x1 - r, y1 - r, 0], // bottom-right
    [x0 + r, y1 - r, Math.PI / 2], // bottom-left
    [x0 + r, y0 + r, Math.PI], // top-left
  ];
  for (const [cx, cy, start] of corners) {
    for (let i = 0; i <= steps; i++) {
      const a = start + (Math.PI / 2) * (i / steps);
      pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    }
  }
  return pts;
}

// ---------------------------------------------------------------------------
// SVG path parsing (custom glyphs from the chat LLM)
//
// Supports M L H V C S Q T Z (absolute + relative). Curves are flattened to
// polylines so fill fraction can be measured deterministically. Arcs (A) are
// rejected — the LLM contract asks for M/L/C/Q/Z only.
// ---------------------------------------------------------------------------

function flattenCubic(p0: Pt, p1: Pt, p2: Pt, p3: Pt, steps = 16): Pt[] {
  const pts: Pt[] = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const mt = 1 - t;
    pts.push({
      x: mt * mt * mt * p0.x + 3 * mt * mt * t * p1.x + 3 * mt * t * t * p2.x + t * t * t * p3.x,
      y: mt * mt * mt * p0.y + 3 * mt * mt * t * p1.y + 3 * mt * t * t * p2.y + t * t * t * p3.y,
    });
  }
  return pts;
}

function flattenQuad(p0: Pt, p1: Pt, p2: Pt, steps = 12): Pt[] {
  const pts: Pt[] = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const mt = 1 - t;
    pts.push({
      x: mt * mt * p0.x + 2 * mt * t * p1.x + t * t * p2.x,
      y: mt * mt * p0.y + 2 * mt * t * p1.y + t * t * p2.y,
    });
  }
  return pts;
}

/** Parse SVG path data (unit-cell coords) into closed polygons. */
export function parseSvgPathToPolys(d: string): Pt[][] {
  const tokens = d.match(/[AaCcHhLlMmQqSsTtVvZz]|-?\d*\.?\d+(?:[eE][-+]?\d+)?/g);
  if (!tokens) throw new QrDesignerError(400, "Custom glyph SVG path is empty.");
  const polys: Pt[][] = [];
  let cur: Pt[] = [];
  let p: Pt = { x: 0, y: 0 };
  let start: Pt = { x: 0, y: 0 };
  let lastCubic: Pt | null = null;
  let lastQuad: Pt | null = null;
  let i = 0;
  const num = (): number => {
    if (i >= tokens.length || /[A-Za-z]/.test(tokens[i])) {
      throw new QrDesignerError(400, "Malformed SVG path in custom glyph.");
    }
    return Number(tokens[i++]);
  };
  const pushCurrent = () => {
    if (cur.length >= 3) polys.push(cur);
    cur = [];
  };
  while (i < tokens.length) {
    const t = tokens[i++];
    if (!/[A-Za-z]/.test(t)) throw new QrDesignerError(400, "Malformed SVG path in custom glyph.");
    const rel = t === t.toLowerCase();
    const cmd = t.toUpperCase();
    const at = (x: number, y: number): Pt => (rel ? { x: p.x + x, y: p.y + y } : { x, y });
    switch (cmd) {
      case "M": {
        pushCurrent();
        p = at(num(), num());
        start = { ...p };
        cur = [p];
        // Implicit lineto pairs after moveto.
        while (i < tokens.length && !/[A-Za-z]/.test(tokens[i])) {
          p = at(num(), num());
          cur.push(p);
        }
        lastCubic = lastQuad = null;
        break;
      }
      case "L": {
        do {
          p = at(num(), num());
          cur.push(p);
        } while (i < tokens.length && !/[A-Za-z]/.test(tokens[i]));
        lastCubic = lastQuad = null;
        break;
      }
      case "H": {
        do {
          const x = num();
          p = rel ? { x: p.x + x, y: p.y } : { x, y: p.y };
          cur.push(p);
        } while (i < tokens.length && !/[A-Za-z]/.test(tokens[i]));
        lastCubic = lastQuad = null;
        break;
      }
      case "V": {
        do {
          const y = num();
          p = rel ? { x: p.x, y: p.y + y } : { x: p.x, y };
          cur.push(p);
        } while (i < tokens.length && !/[A-Za-z]/.test(tokens[i]));
        lastCubic = lastQuad = null;
        break;
      }
      case "C": {
        do {
          const c1 = at(num(), num());
          const c2 = at(num(), num());
          const end = at(num(), num());
          cur.push(...flattenCubic(p, c1, c2, end));
          lastCubic = c2;
          lastQuad = null;
          p = end;
        } while (i < tokens.length && !/[A-Za-z]/.test(tokens[i]));
        break;
      }
      case "S": {
        do {
          const c1 = lastCubic ? { x: 2 * p.x - lastCubic.x, y: 2 * p.y - lastCubic.y } : { ...p };
          const c2 = at(num(), num());
          const end = at(num(), num());
          cur.push(...flattenCubic(p, c1, c2, end));
          lastCubic = c2;
          lastQuad = null;
          p = end;
        } while (i < tokens.length && !/[A-Za-z]/.test(tokens[i]));
        break;
      }
      case "Q": {
        do {
          const c = at(num(), num());
          const end = at(num(), num());
          cur.push(...flattenQuad(p, c, end));
          lastQuad = c;
          lastCubic = null;
          p = end;
        } while (i < tokens.length && !/[A-Za-z]/.test(tokens[i]));
        break;
      }
      case "T": {
        do {
          const c: Pt = lastQuad ? { x: 2 * p.x - lastQuad.x, y: 2 * p.y - lastQuad.y } : { ...p };
          const end = at(num(), num());
          cur.push(...flattenQuad(p, c, end));
          lastQuad = c;
          lastCubic = null;
          p = end;
        } while (i < tokens.length && !/[A-Za-z]/.test(tokens[i]));
        break;
      }
      case "Z": {
        if (cur.length > 0) {
          cur.push({ ...start });
          p = { ...start };
        }
        pushCurrent();
        lastCubic = lastQuad = null;
        break;
      }
      default:
        throw new QrDesignerError(
          400,
          `Custom glyph SVG uses unsupported command "${t}" — use M/L/H/V/C/S/Q/T/Z only (no arcs).`,
        );
    }
  }
  pushCurrent();
  if (polys.length === 0) throw new QrDesignerError(400, "Custom glyph SVG path produced no drawable shape.");
  return polys;
}

// ---------------------------------------------------------------------------
// Procedural glyph library (deterministic fallback — no LLM key needed)
// ---------------------------------------------------------------------------

function starPoly(cx: number, cy: number, outer: number, inner: number, points = 5): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = -Math.PI / 2 + (Math.PI * i) / points;
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return pts;
}

/** Wavy "snake-ish" blob: sinusoidal radius closed curve. */
function blobPoly(steps = 72): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i < steps; i++) {
    const a = (2 * Math.PI * i) / steps;
    const r = 0.4 + 0.09 * Math.sin(3 * a + 0.7) + 0.04 * Math.cos(5 * a);
    pts.push({ x: 0.5 + r * Math.cos(a), y: 0.5 + r * Math.sin(a) });
  }
  return pts;
}

/** Droplet: round belly + pointed tip (union of circle + triangle). */
function dropletPolys(): Pt[][] {
  const belly = circlePoly(0.5, 0.62, 0.32, 40);
  const tip: Pt[] = [
    { x: 0.22, y: 0.58 },
    { x: 0.78, y: 0.58 },
    { x: 0.5, y: 0.04 },
  ];
  return [belly, tip];
}

const PROCEDURAL_GLYPHS: Record<Exclude<ModuleGlyphKind, "custom-svg">, () => GlyphDesign> = {
  square: () => ({
    kind: "square",
    label: "classic squares",
    polys: [[{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]],
    fillFraction: 1,
    minFeatureWidth: 1,
  }),
  rounded: () => {
    const polys = [roundedRectPoly(0.05, 0.24)];
    return { kind: "rounded", label: "soft rounded squares", polys, fillFraction: measureFillFraction(polys), minFeatureWidth: 0.2 };
  },
  dots: () => {
    const polys = [circlePoly(0.5, 0.5, 0.48)];
    return { kind: "dots", label: "round dots", polys, fillFraction: measureFillFraction(polys), minFeatureWidth: 0.3 };
  },
};

function proceduralBlob(): GlyphDesign {
  const polys = [blobPoly()];
  return { kind: "custom-svg", label: "wavy snake blobs", polys, fillFraction: measureFillFraction(polys), minFeatureWidth: 0.12 };
}
function proceduralStar(): GlyphDesign {
  const polys = [starPoly(0.5, 0.5, 0.5, 0.21)];
  return { kind: "custom-svg", label: "little stars", polys, fillFraction: measureFillFraction(polys), minFeatureWidth: 0.1 };
}
function proceduralDroplet(): GlyphDesign {
  const polys = dropletPolys();
  return { kind: "custom-svg", label: "droplets", polys, fillFraction: measureFillFraction(polys), minFeatureWidth: 0.12 };
}

/**
 * Deterministic glyph picker — the fallback that works with no LLM key.
 * Maps a natural-language description to a procedural glyph.
 */
export function designGlyph(description: string): GlyphDesign {
  const d = description.toLowerCase();
  if (/(snake|serpent|wavy|blob|worm|squiggle)/.test(d)) return proceduralBlob();
  if (/(star)/.test(d)) return proceduralStar();
  if (/(drop|droplet|water|tear)/.test(d)) return proceduralDroplet();
  if (/(dot|circle|pebble|round module)/.test(d)) return PROCEDURAL_GLYPHS.dots();
  if (/(square|classic|sharp|block)/.test(d)) return PROCEDURAL_GLYPHS.square();
  return PROCEDURAL_GLYPHS.rounded();
}

/** Build a GlyphDesign from an LLM-designed SVG path (measured, not trusted). */
export function glyphFromLlmSvg(
  svgPath: string,
  declared: { label: string; fillFraction: number; minFeatureWidth: number },
): GlyphDesign {
  const polys = parseSvgPathToPolys(svgPath);
  const measured = measureFillFraction(polys);
  return {
    kind: "custom-svg",
    label: declared.label || "custom glyph",
    polys,
    customSvgPath: svgPath,
    // Trust the measurement over the declaration — validation reads pixels.
    fillFraction: measured,
    minFeatureWidth: declared.minFeatureWidth,
  };
}

/** Resolve the active glyph for a style spec (procedural or LLM path). */
export async function resolveGlyph(
  spec: QrStyleSpec,
  glyphLlm: QrGlyphLlm | null,
): Promise<GlyphDesign> {
  if (spec.moduleGlyph === "custom-svg" && spec.customGlyphSvg) {
    return glyphFromLlmSvg(spec.customGlyphSvg, {
      label: spec.glyphLabel,
      fillFraction: spec.fillFraction,
      minFeatureWidth: 0.1,
    });
  }
  if (spec.moduleGlyph !== "custom-svg" && PROCEDURAL_GLYPHS[spec.moduleGlyph]) {
    return PROCEDURAL_GLYPHS[spec.moduleGlyph]();
  }
  // "describe it and the AI draws it": LLM first, procedural fallback.
  if (glyphLlm) {
    try {
      const out = await glyphLlm.designGlyph(spec.glyphLabel);
      return glyphFromLlmSvg(out.svgPath, out);
    } catch {
      // LLM failure falls through to the deterministic glyph.
    }
  }
  return designGlyph(spec.glyphLabel);
}

// ---------------------------------------------------------------------------
// Natural-language style parsing
// ---------------------------------------------------------------------------

const HEX_RE = /#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/g;

export function parseStylePrompt(prompt: string, brand?: BrandContext): QrStyleIntent {
  const p = (prompt || "").toLowerCase();
  const intent: QrStyleIntent = {
    glyphHint: prompt.trim() || "rounded",
    shapeMask: /\b(round|circular|circle)\b/.test(p) ? "round" : "square",
  };
  // Colors: explicit hexes first, then named colors. First = foreground.
  const hexes = Array.from(new Set(Array.from((prompt.match(HEX_RE) ?? []) as string[]).map((h) => normalizeHexColor(h)).filter(Boolean) as string[]));
  const named: string[] = [];
  for (const name of Object.keys(NAMED_COLORS)) {
    if (new RegExp(`\\b${name}\\b`).test(p) && !named.includes(NAMED_COLORS[name])) named.push(NAMED_COLORS[name]);
  }
  const colors = [...hexes, ...named];
  if (colors[0]) intent.foreground = colors[0];
  if (colors[1]) intent.background = colors[1];
  // Brand context fills what the prompt didn't say.
  if (brand?.foreground && !intent.foreground) intent.foreground = normalizeHexColor(brand.foreground) ?? undefined;
  if (brand?.background && !intent.background) intent.background = normalizeHexColor(brand.background) ?? undefined;
  if (brand?.logoDataUrl) intent.logoDataUrl = brand.logoDataUrl;
  // CTA: quoted "scan ..." text, or cta: "...".
  const ctaM = /(?:cta\s*[:：]\s*)?["“]([^"”]{2,60})["”]/i.exec(prompt);
  if (ctaM) intent.frameCta = ctaM[1].trim();
  return intent;
}

/** Decode a data-URL (or raw base64) logo into PNG bytes. PNG-only: the
 *  compositor reads pixels with PNG.sync.read, so anything else is rejected
 *  here with a named error instead of being silently dropped at render. */
export function decodeLogoImage(dataUrl: string): Buffer {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl.trim());
  const b64 = m ? m[1] : /^[A-Za-z0-9+/=]+$/.test(dataUrl.trim()) ? dataUrl.trim() : null;
  if (!b64) throw new QrDesignerError(400, "Logo must be a PNG data URL (or raw PNG base64). JPEG is not supported — convert to PNG first.");
  const buf = Buffer.from(b64, "base64");
  if (buf.length === 0 || buf.length > 4 * 1024 * 1024) {
    throw new QrDesignerError(400, "Logo image is empty or exceeds 4 MB.");
  }
  const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_MAGIC)) {
    throw new QrDesignerError(400, "Logo bytes are not a valid PNG. Convert the logo to PNG and try again.");
  }
  return buf;
}

// ---------------------------------------------------------------------------
// QR matrix — the ENCODED DATA layer. Generated by the `qrcode` library from
// the target URL; the styling layer below only ever reads it.
// ---------------------------------------------------------------------------

export interface QrMatrix {
  size: number;
  version: number;
  dark: (r: number, c: number) => boolean;
}

const MAX_URL_LEN = 1500;

export function generateQrMatrix(text: string): QrMatrix {
  if (!text || text.length > MAX_URL_LEN) {
    throw new QrDesignerError(400, `Target URL must be 1–${MAX_URL_LEN} characters.`);
  }
  let qr;
  try {
    // Error correction is FORCED to H for styled codes (spec §A1).
    qr = QRCode.create(text, { errorCorrectionLevel: "H" });
  } catch (err) {
    throw new QrDesignerError(400, `Could not encode target URL as a QR code: ${err instanceof Error ? err.message : "unknown"}`);
  }
  const size = qr.modules.size;
  return {
    size,
    version: qr.version,
    dark: (r: number, c: number) => qr.modules.get(r, c) === 1,
  };
}

/** The 7x7 finder pattern: dark ring + dark 3x3 core. */
export function finderPatternDark(dr: number, dc: number): boolean {
  if (dr < 0 || dr > 6 || dc < 0 || dc > 6) return false;
  return dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4);
}

/** Finder 8x8 block: the 7x7 pattern origin + the absolute separator row/col. */
function finderZone(
  n: number,
  r: number,
  c: number,
): { zr: number; zc: number; sepR: number; sepC: number } | null {
  // Top-left: pattern 0..6, separator row 7 / col 7.
  if (r < 8 && c < 8) return { zr: 0, zc: 0, sepR: 7, sepC: 7 };
  // Top-right: pattern rows 0..6, cols n-7..n-1; separator row 7 / col n-8.
  if (r < 8 && c >= n - 8) return { zr: 0, zc: n - 7, sepR: 7, sepC: n - 8 };
  // Bottom-left: pattern rows n-7..n-1, cols 0..6; separator row n-8 / col 7.
  if (r >= n - 8 && c < 8) return { zr: n - 7, zc: 0, sepR: n - 8, sepC: 7 };
  return null;
}

// Alignment-pattern centers per QR version (0-indexed module coords).
const ALIGNMENT_CENTERS: Record<number, number[]> = {
  2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
  7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
  11: [6, 30, 54], 12: [6, 32, 58], 13: [6, 34, 62],
  14: [6, 26, 46, 66], 15: [6, 26, 48, 70], 16: [6, 26, 50, 74],
  17: [6, 30, 54, 78], 18: [6, 30, 56, 82], 19: [6, 30, 58, 86],
  20: [6, 34, 62, 90], 21: [6, 28, 50, 72, 94], 22: [6, 26, 50, 74, 98],
  23: [6, 30, 54, 78, 102], 24: [6, 28, 54, 80, 106],
  25: [6, 32, 58, 84, 110], 26: [6, 30, 58, 86, 114],
  27: [6, 34, 62, 90, 118], 28: [6, 26, 50, 74, 98, 122],
  29: [6, 30, 54, 78, 102, 126], 30: [6, 26, 52, 78, 104, 130],
  31: [6, 30, 56, 82, 108, 134], 32: [6, 34, 60, 86, 112, 138],
  33: [6, 30, 58, 86, 114, 142], 34: [6, 34, 62, 90, 118, 146],
  35: [6, 30, 54, 78, 102, 126, 150], 36: [6, 24, 50, 76, 102, 128, 154],
  37: [6, 28, 54, 80, 106, 132, 158], 38: [6, 32, 58, 84, 110, 136, 162],
  39: [6, 26, 54, 82, 110, 138, 166], 40: [6, 30, 58, 86, 114, 142, 170],
};

/**
 * Function patterns are part of the encoded-data layer's readability: timing,
 * alignment, and version-info modules are always drawn crisp (solid), never
 * with the artwork glyph. Only data modules get the art.
 */
export function isFunctionPattern(n: number, version: number, r: number, c: number): boolean {
  if (finderZone(n, r, c)) return true;
  if (r === 6 || c === 6) return true; // timing patterns
  const centers = ALIGNMENT_CENTERS[version] ?? [];
  for (const ar of centers) {
    for (const ac of centers) {
      // Skip the three that overlap the finder patterns.
      if ((ar === 6 && ac === 6) || (ar === 6 && ac === centers[centers.length - 1]) || (ar === centers[centers.length - 1] && ac === 6)) continue;
      if (Math.abs(r - ar) <= 2 && Math.abs(c - ac) <= 2) return true;
    }
  }
  if (version >= 7) {
    // Version-information blocks: 6x3 near the top-right and bottom-left.
    if (r < 6 && c >= n - 11 && c < n - 8) return true;
    if (c < 6 && r >= n - 11 && r < n - 8) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 5x7 bitmap font (CTA text on the PNG frame band — deterministic, no deps)
// ---------------------------------------------------------------------------

const FONT5X7: Record<string, number[]> = {
  A: [14, 17, 17, 31, 17, 17, 17], B: [30, 17, 17, 30, 17, 17, 30],
  C: [14, 17, 16, 16, 16, 17, 14], D: [30, 17, 17, 17, 17, 17, 30],
  E: [31, 16, 16, 30, 16, 16, 31], F: [31, 16, 16, 30, 16, 16, 16],
  G: [14, 17, 16, 23, 17, 17, 14], H: [17, 17, 17, 31, 17, 17, 17],
  I: [14, 4, 4, 4, 4, 4, 14], J: [7, 2, 2, 2, 2, 18, 12],
  K: [17, 18, 20, 24, 20, 18, 17], L: [16, 16, 16, 16, 16, 16, 31],
  M: [17, 27, 21, 21, 17, 17, 17], N: [17, 25, 25, 21, 19, 19, 17],
  O: [14, 17, 17, 17, 17, 17, 14], P: [30, 17, 17, 30, 16, 16, 16],
  Q: [14, 17, 17, 17, 21, 18, 13], R: [30, 17, 17, 30, 20, 18, 17],
  S: [15, 16, 16, 14, 1, 1, 30], T: [31, 4, 4, 4, 4, 4, 4],
  U: [17, 17, 17, 17, 17, 17, 14], V: [17, 17, 17, 17, 17, 10, 4],
  W: [17, 17, 17, 21, 21, 27, 17], X: [17, 17, 10, 4, 10, 17, 17],
  Y: [17, 17, 10, 4, 4, 4, 4], Z: [31, 1, 2, 4, 8, 16, 31],
  "0": [14, 17, 19, 21, 25, 17, 14], "1": [4, 12, 4, 4, 4, 4, 14],
  "2": [14, 17, 1, 2, 4, 8, 31], "3": [31, 2, 4, 2, 1, 17, 14],
  "4": [2, 6, 10, 18, 31, 2, 2], "5": [31, 16, 30, 1, 1, 17, 14],
  "6": [6, 8, 16, 30, 17, 17, 14], "7": [31, 1, 2, 4, 8, 8, 8],
  "8": [14, 17, 17, 14, 17, 17, 14], "9": [14, 17, 17, 15, 1, 2, 12],
  " ": [0, 0, 0, 0, 0, 0, 0], ".": [0, 0, 0, 0, 0, 12, 12],
  ",": [0, 0, 0, 0, 12, 12, 8], "!": [4, 4, 4, 4, 4, 0, 4],
  "?": [14, 17, 1, 2, 4, 0, 4], "-": [0, 0, 0, 31, 0, 0, 0],
  "%": [25, 26, 2, 4, 8, 11, 19], ":": [0, 12, 12, 0, 12, 12, 0],
  "/": [1, 2, 2, 4, 8, 8, 16], "'": [4, 4, 8, 0, 0, 0, 0],
  "&": [12, 18, 18, 20, 21, 22, 13], "(": [2, 4, 8, 8, 8, 4, 2],
  ")": [8, 4, 2, 2, 2, 4, 8], "+": [0, 4, 4, 31, 4, 4, 0],
  '"': [10, 10, 10, 0, 0, 0, 0], "*": [0, 4, 21, 14, 21, 4, 0],
};

// ---------------------------------------------------------------------------
// Renderer — artwork layer. Reads the matrix, never writes it.
// ---------------------------------------------------------------------------

export interface RenderOptions {
  /** Pixels per QR module (default 14). */
  modulePx?: number;
}

export interface RenderedQr {
  png: Buffer;
  svg: string;
  width: number;
  height: number;
  modulePx: number;
  quietPx: number;
  codeOriginX: number;
  codeOriginY: number;
  codePx: number;
  matrixSize: number;
  logoRect: { x: number; y: number; w: number; h: number } | null;
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function setPx(png: PNG, x: number, y: number, c: Rgb): void {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
  const i = (png.width * y + x) << 2;
  png.data[i] = c.r;
  png.data[i + 1] = c.g;
  png.data[i + 2] = c.b;
  png.data[i + 3] = 255;
}

function fillRect(png: PNG, x: number, y: number, w: number, h: number, c: Rgb): void {
  for (let yy = Math.max(0, y); yy < Math.min(png.height, y + h); yy++) {
    for (let xx = Math.max(0, x); xx < Math.min(png.width, x + w); xx++) {
      setPx(png, xx, yy, c);
    }
  }
}

function drawText(png: PNG, text: string, cx: number, yTop: number, scale: number, c: Rgb): void {
  const chars = text.toUpperCase().split("");
  const w = chars.length * 6 * scale - scale;
  let x = Math.round(cx - w / 2);
  for (const ch of chars) {
    const rows = FONT5X7[ch] ?? FONT5X7[" "];
    for (let r = 0; r < 7; r++) {
      for (let col = 0; col < 5; col++) {
        if (rows[r] & (16 >> col)) {
          fillRect(png, x + col * scale, yTop + r * scale, scale, scale, c);
        }
      }
    }
    x += 6 * scale;
  }
}

function polyToSvgPath(poly: Pt[]): string {
  const pts = poly.map((p) => `${p.x.toFixed(4)},${p.y.toFixed(4)}`).join("L");
  return `M${pts}Z`;
}

export function renderStyledQr(
  matrix: QrMatrix,
  spec: QrStyleSpec,
  glyph: GlyphDesign,
  opts?: RenderOptions,
): RenderedQr {
  const n = matrix.size;
  const mPx = Math.max(8, Math.min(32, Math.round(opts?.modulePx ?? 14)));
  const qz = Math.max(4, Math.round(spec.quietZoneModules));
  const codePx = n * mPx;
  const quietPx = qz * mPx;
  const fg = hexToRgb(spec.foreground);
  const bg = hexToRgb(spec.background);
  const frameBand = spec.frameCta ? Math.max(14, Math.round(mPx * 1.6)) : 0;

  const W = codePx + quietPx * 2 + frameBand * 2;
  const H = W;
  const ox = frameBand + quietPx; // code origin x
  const oy = frameBand + quietPx;

  const png = new PNG({ width: W, height: H });
  fillRect(png, 0, 0, W, H, bg);

  // Frame band: fg border around the quiet zone + CTA text in the bottom band.
  if (spec.frameCta) {
    const bw = Math.max(2, Math.round(mPx * 0.12));
    fillRect(png, frameBand - bw, frameBand - bw, W - 2 * (frameBand - bw), bw, fg); // top
    fillRect(png, frameBand - bw, H - frameBand, W - 2 * (frameBand - bw), bw, fg); // bottom
    fillRect(png, frameBand - bw, frameBand - bw, bw, H - 2 * (frameBand - bw), fg); // left
    fillRect(png, W - frameBand, frameBand - bw, bw, H - 2 * (frameBand - bw), fg); // right
    const scale = Math.max(2, Math.min(5, Math.floor(frameBand / 12)));
    drawText(png, spec.frameCta, W / 2, H - frameBand + Math.round((frameBand - 7 * scale) / 2), scale, fg);
  }

  const centerPx = ox + codePx / 2;
  const radiusPx = codePx / 2;

  // Which block-corner cell is the "outer" corner for rounded finders.
  const finderOuterCorner: Record<string, { dr: number; dc: number; cx: number; cy: number }> = {
    "0,0": { dr: 0, dc: 0, cx: 0, cy: 0 },
    [`0,${n - 7}`]: { dr: 0, dc: 6, cx: 1, cy: 0 },
    [`${n - 7},0`]: { dr: 6, dc: 0, cx: 0, cy: 1 },
  };

  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const zone = finderZone(n, r, c);
      const x0 = ox + c * mPx;
      const y0 = oy + r * mPx;

      if (zone) {
        // FINDER ZONE — the exact 7x7 pattern is drawn, never the glyph.
        const pr = r - zone.zr;
        const pc = c - zone.zc;
        if (r === zone.sepR || c === zone.sepC) continue; // separator — stays background
        if (!finderPatternDark(pr, pc)) continue;
        const key = `${zone.zr},${zone.zc}`;
        const outer = finderOuterCorner[key];
        const rounded = spec.finderStyle === "rounded" && outer && pr === outer.dr && pc === outer.dc;
        if (!rounded) {
          fillRect(png, x0, y0, mPx, mPx, fg);
        } else {
          const rad = 0.3 * mPx;
          const cornerX = x0 + outer.cx * mPx;
          const cornerY = y0 + outer.cy * mPx;
          for (let py = 0; py < mPx; py++) {
            for (let px = 0; px < mPx; px++) {
              const dx = x0 + px + 0.5 - cornerX;
              const dy = y0 + py + 0.5 - cornerY;
              if (dx * dx + dy * dy >= rad * rad) setPx(png, x0 + px, y0 + py, fg);
            }
          }
        }
        continue;
      }

      if (!matrix.dark(r, c)) continue;

      if (isFunctionPattern(n, matrix.version, r, c)) {
        // Timing / alignment / version-info: crisp, never the artwork glyph.
        fillRect(png, x0, y0, mPx, mPx, fg);
        continue;
      }

      if (spec.shapeMask === "round") {
        // Keep every module that touches the inscribed circle (nearest-
        // corner test): the round silhouette survives, but total
        // data-module damage stays inside EC-H's unknown-error budget.
        // Finders were handled above and are exempt by construction.
        const nx = Math.min(Math.max(centerPx, x0), x0 + mPx);
        const ny = Math.min(Math.max(centerPx, y0), y0 + mPx);
        const ndx = nx - centerPx;
        const ndy = ny - centerPx;
        if (ndx * ndx + ndy * ndy > radiusPx * radiusPx) continue;
      }

      for (let py = 0; py < mPx; py++) {
        for (let px = 0; px < mPx; px++) {
          if (pointInGlyph((px + 0.5) / mPx, (py + 0.5) / mPx, glyph.polys)) {
            setPx(png, x0 + px, y0 + py, fg);
          }
        }
      }
    }
  }

  // Center logo: clear zone (background rounded rect) + composited logo.
  let logoRect: RenderedQr["logoRect"] = null;
  if (spec.logoImagePng) {
    try {
      const logo = PNG.sync.read(spec.logoImagePng);
      // Round masks already sacrifice the corner modules — keep the logo
      // smaller there so total unknown-location errors stay well inside
      // EC-H's ~15% budget (mask corners + logo center compound).
      const logoRatio = spec.shapeMask === "round" ? 0.11 : 0.2;
      const logoPx = Math.round(codePx * logoRatio);
      const margin = mPx;
      const clear = logoPx + margin * 2;
      const lx = Math.round(centerPx - logoPx / 2);
      const ly = Math.round(centerPx - logoPx / 2);
      // Clear zone — plain background so the logo never fights the modules.
      for (let py = 0; py < clear; py++) {
        for (let px = 0; px < clear; px++) {
          const u = px / clear;
          const v = py / clear;
          const rr = 0.18;
          const inCorner =
            (u < rr && v < rr && (u - rr) * (u - rr) + (v - rr) * (v - rr) > rr * rr) ||
            (u > 1 - rr && v < rr && (u - 1 + rr) * (u - 1 + rr) + (v - rr) * (v - rr) > rr * rr) ||
            (u < rr && v > 1 - rr && (u - rr) * (u - rr) + (v - 1 + rr) * (v - 1 + rr) > rr * rr) ||
            (u > 1 - rr && v > 1 - rr && (u - 1 + rr) * (u - 1 + rr) + (v - 1 + rr) * (v - 1 + rr) > rr * rr);
          if (!inCorner) setPx(png, lx - margin + px, ly - margin + py, bg);
        }
      }
      // Nearest-neighbor scale + alpha composite.
      for (let py = 0; py < logoPx; py++) {
        for (let px = 0; px < logoPx; px++) {
          const sx = Math.min(logo.width - 1, Math.floor((px / logoPx) * logo.width));
          const sy = Math.min(logo.height - 1, Math.floor((py / logoPx) * logo.height));
          const si = (logo.width * sy + sx) << 2;
          const a = logo.data[si + 3] / 255;
          if (a <= 0) continue;
          const dx = lx + px;
          const dy = ly + py;
          if (dx < 0 || dy < 0 || dx >= W || dy >= H) continue;
          const di = (W * dy + dx) << 2;
          const br = png.data[di];
          const bgg = png.data[di + 1];
          const bb = png.data[di + 2];
          png.data[di] = Math.round(logo.data[si] * a + br * (1 - a));
          png.data[di + 1] = Math.round(logo.data[si + 1] * a + bgg * (1 - a));
          png.data[di + 2] = Math.round(logo.data[si + 2] * a + bb * (1 - a));
          png.data[di + 3] = 255;
        }
      }
      logoRect = { x: lx - margin, y: ly - margin, w: clear, h: clear };
    } catch {
      // Undecodable logo bytes: skip the logo rather than corrupt the code.
      logoRect = null;
    }
  }

  const pngBuf = PNG.sync.write(png);
  const svg = buildSvg(matrix, spec, glyph, { W, H, ox, oy, mPx, codePx, centerPx, quietPx, frameBand, logoRect });
  return {
    png: pngBuf,
    svg,
    width: W,
    height: H,
    modulePx: mPx,
    quietPx,
    codeOriginX: ox,
    codeOriginY: oy,
    codePx,
    matrixSize: n,
    logoRect,
  };
}

interface SvgLayout {
  W: number;
  H: number;
  ox: number;
  oy: number;
  mPx: number;
  codePx: number;
  centerPx: number;
  quietPx: number;
  frameBand: number;
  logoRect: RenderedQr["logoRect"];
}

function escXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function buildSvg(matrix: QrMatrix, spec: QrStyleSpec, glyph: GlyphDesign, L: SvgLayout): string {
  const n = matrix.size;
  const parts: string[] = [];
  const clipId = "qrmask";
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${L.W} ${L.H}" width="${L.W}" height="${L.H}" role="img" aria-label="QR code">`,
  );
  parts.push(`<rect width="${L.W}" height="${L.H}" fill="${spec.background}"/>`);
  if (spec.shapeMask === "round") {
    parts.push(
      `<defs><clipPath id="${clipId}"><circle cx="${L.centerPx.toFixed(1)}" cy="${L.centerPx.toFixed(1)}" r="${(L.codePx / 2).toFixed(1)}"/></clipPath></defs>`,
    );
  }
  // NEVER embed a raw user/LLM-supplied path string: it is interpolated
  // into a d="..." attribute and could break out of it. Re-serialize from
  // the parsed polygons instead — only M/L/Z and numbers survive.
  const glyphPath = glyph.polys.map(polyToSvgPath).join("");
  // Data modules (finders drawn separately, never clipped).
  parts.push(spec.shapeMask === "round" ? `<g clip-path="url(#${clipId})">` : "<g>");
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (finderZone(n, r, c)) continue;
      if (!matrix.dark(r, c)) continue;
      const x = (L.ox + c * L.mPx).toFixed(1);
      const y = (L.oy + r * L.mPx).toFixed(1);
      if (isFunctionPattern(n, matrix.version, r, c)) {
        parts.push(`<rect x="${x}" y="${y}" width="${L.mPx}" height="${L.mPx}" fill="${spec.foreground}"/>`);
        continue;
      }
      parts.push(
        `<path d="${glyphPath}" transform="translate(${x} ${y}) scale(${L.mPx})" fill="${spec.foreground}"/>`,
      );
    }
  }
  parts.push("</g>");
  // Finder patterns — exact, unclipped, always present.
  const fr = spec.finderStyle === "rounded" ? Math.round(L.mPx * 0.28) : 0;
  for (const [zr, zc] of [[0, 0], [0, n - 7], [n - 7, 0]] as Array<[number, number]>) {
    for (let dr = 0; dr < 7; dr++) {
      for (let dc = 0; dc < 7; dc++) {
        if (!finderPatternDark(dr, dc)) continue;
        const x = (L.ox + (zc + dc) * L.mPx).toFixed(1);
        const y = (L.oy + (zr + dr) * L.mPx).toFixed(1);
        parts.push(
          `<rect x="${x}" y="${y}" width="${L.mPx}" height="${L.mPx}" fill="${spec.foreground}"${fr ? ` rx="${fr}"` : ""}/>`,
        );
      }
    }
  }
  if (L.logoRect && spec.logoImagePng) {
    const b64 = spec.logoImagePng.toString("base64");
    const clear = L.logoRect.w;
    const logoPx = clear - 2 * L.mPx;
    parts.push(`<rect x="${L.logoRect.x}" y="${L.logoRect.y}" width="${clear}" height="${clear}" rx="${Math.round(L.mPx * 0.9)}" fill="${spec.background}"/>`);
    parts.push(
      `<image href="data:image/png;base64,${b64}" x="${L.logoRect.x + L.mPx}" y="${L.logoRect.y + L.mPx}" width="${logoPx}" height="${logoPx}"/>`,
    );
  }
  if (spec.frameCta && L.frameBand > 0) {
    const bw = Math.max(2, Math.round(L.mPx * 0.12));
    parts.push(
      `<rect x="${L.frameBand - bw}" y="${L.frameBand - bw}" width="${L.W - 2 * (L.frameBand - bw)}" height="${L.H - 2 * (L.frameBand - bw)}" fill="none" stroke="${spec.foreground}" stroke-width="${bw}"/>`,
    );
    parts.push(
      `<text x="${L.W / 2}" y="${L.H - L.frameBand / 2}" text-anchor="middle" dominant-baseline="central" font-family="monospace" font-size="${Math.round(L.frameBand * 0.42)}" fill="${spec.foreground}">${escXml(spec.frameCta)}</text>`,
    );
  }
  parts.push("</svg>");
  return parts.join("");
}

// ---------------------------------------------------------------------------
// Automated validation — runs on the RENDERED PIXELS before any preview.
// A styled code that fails validation never reaches the approval object.
// ---------------------------------------------------------------------------

export interface QrValidationIssue {
  code: string;
  message: string;
}

export interface QrValidationResult {
  ok: boolean;
  issues: QrValidationIssue[];
  metrics: {
    contrastRatio: number;
    meanGlyphFill: number;
    thinModuleShare: number;
    finderMatchPct: number;
    quietZoneOk: boolean;
    decodeOk: boolean;
    decodedUrl: string | null;
  };
}

const MIN_CONTRAST = 3.0;
const MIN_GLYPH_FILL = 0.35;
const MAX_THIN_SHARE = 0.1;
const MIN_FINDER_MATCH = 0.97;

function pxLuminance(png: PNG, x: number, y: number): number {
  const i = (png.width * y + x) << 2;
  const r = png.data[i] / 255;
  const g = png.data[i + 1] / 255;
  const b = png.data[i + 2] / 255;
  const f = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function scanTestQr(pngBuf: Buffer, expectedUrl: string): { passed: boolean; decoded: string | null } {
  let png: PNG;
  try {
    png = PNG.sync.read(pngBuf);
  } catch {
    return { passed: false, decoded: null };
  }
  const lum = new Uint8ClampedArray(png.width * png.height * 4);
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const v = Math.round(pxLuminance(png, x, y) * 255);
      const o = (y * png.width + x) * 4;
      lum[o] = v;
      lum[o + 1] = v;
      lum[o + 2] = v;
      lum[o + 3] = 255;
    }
  }
  const found = jsQR(lum, png.width, png.height);
  const decoded = found?.data ?? null;
  return { passed: decoded === expectedUrl, decoded };
}

/**
 * Full automated validation of a rendered styled QR against its matrix, spec,
 * and expected URL. Checks: forced EC-H, quiet-zone width, contrast ratio,
 * quiet-zone pixels, finder-pattern integrity (pixel-sampled), per-module
 * glyph fill, and a real decoder scan test.
 */
export function validateRenderedQr(
  rendered: RenderedQr,
  matrix: QrMatrix,
  spec: QrStyleSpec,
  expectedUrl: string,
): QrValidationResult {
  const issues: QrValidationIssue[] = [];
  const n = matrix.size;
  const mPx = rendered.modulePx;
  const ox = rendered.codeOriginX;
  const oy = rendered.codeOriginY;
  const fgL = relativeLuminance(spec.foreground);
  const bgL = relativeLuminance(spec.background);
  const contrast = contrastRatio(spec.foreground, spec.background);

  if (spec.errorCorrection !== "H") {
    issues.push({ code: "ec-not-h", message: "Styled QR codes must use error correction level H." });
  }
  if (spec.quietZoneModules < 4) {
    issues.push({ code: "quiet-zone-too-small", message: "Quiet zone must be at least 4 modules." });
  }
  if (contrast < MIN_CONTRAST) {
    issues.push({
      code: "contrast-too-low",
      message: `Contrast ${contrast.toFixed(2)}:1 is below ${MIN_CONTRAST}:1 — foreground and background are too close and the code would mis-scan.`,
    });
  }

  let png: PNG | null = null;
  try {
    png = PNG.sync.read(rendered.png);
  } catch {
    issues.push({ code: "unreadable-png", message: "Rendered PNG could not be decoded for validation." });
  }

  let quietZoneOk = false;
  let finderMatchPct = 0;
  let meanGlyphFill = 0;
  let thinModuleShare = 0;

  if (png) {
    const isDark = (x: number, y: number): boolean => {
      const l = pxLuminance(png as PNG, x, y);
      return Math.abs(l - fgL) < Math.abs(l - bgL);
    };
    const isLight = (x: number, y: number): boolean => {
      const l = pxLuminance(png as PNG, x, y);
      return Math.abs(l - bgL) < 0.12;
    };

    // Quiet zone: the band around the code must read light everywhere.
    // (Frame bands, when present, sit outside the quiet zone.)
    const q = rendered.quietPx;
    const cx0 = rendered.codeOriginX;
    const cy0 = rendered.codeOriginY;
    const cx1 = cx0 + rendered.codePx;
    const cy1 = cy0 + rendered.codePx;
    let quietBad = 0;
    let quietTotal = 0;
    const band = Math.max(2, Math.floor(q / 2));
    for (let x = cx0 - q; x < cx1 + q; x += 3) {
      for (const y of [cy0 - band, cy1 + band]) {
        quietTotal++;
        if (!isLight(x, y)) quietBad++;
      }
    }
    for (let y = cy0 - q; y < cy1 + q; y += 3) {
      for (const x of [cx0 - band, cx1 + band]) {
        quietTotal++;
        if (!isLight(x, y)) quietBad++;
      }
    }
    quietZoneOk = quietTotal > 0 && quietBad / quietTotal < 0.02;
    if (!quietZoneOk) {
      issues.push({
        code: "quiet-zone-broken",
        message: `Quiet zone is damaged (${quietBad}/${quietTotal} sampled pixels not background) — scanners need a clean margin around the code.`,
      });
    }

    // Finder integrity: sample every cell center of the three 7x7 patterns
    // against the true pattern. Position squares must stay intact.
    let matched = 0;
    let total = 0;
    for (const [zr, zc] of [[0, 0], [0, n - 7], [n - 7, 0]]) {
      for (let dr = 0; dr < 7; dr++) {
        for (let dc = 0; dc < 7; dc++) {
          const expected = finderPatternDark(dr, dc);
          const x = Math.round(ox + (zc + dc + 0.5) * mPx);
          const y = Math.round(oy + (zr + dr + 0.5) * mPx);
          total++;
          if (isDark(x, y) === expected) matched++;
        }
      }
    }
    finderMatchPct = total ? matched / total : 0;
    if (finderMatchPct < MIN_FINDER_MATCH) {
      issues.push({
        code: "finder-pattern-damaged",
        message: `Finder-pattern integrity ${(finderMatchPct * 100).toFixed(1)}% < ${(MIN_FINDER_MATCH * 100).toFixed(0)}% — position squares must stay intact and readable; restyle without touching the finders.`,
      });
    }

    // Glyph fill: per dark DATA module, fraction of cell pixels reading dark.
    // Skips finder zones, function patterns, the logo clear zone, and
    // mask-dropped modules — this measures the artwork, not the geometry.
    const fills: number[] = [];
    const logo = rendered.logoRect;
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (finderZone(n, r, c)) continue;
        if (isFunctionPattern(n, matrix.version, r, c)) continue;
        if (!matrix.dark(r, c)) continue;
        const x0 = ox + c * mPx;
        const y0 = oy + r * mPx;
        if (logo && x0 + mPx / 2 >= logo.x && x0 + mPx / 2 <= logo.x + logo.w && y0 + mPx / 2 >= logo.y && y0 + mPx / 2 <= logo.y + logo.h) {
          continue;
        }
        if (spec.shapeMask === "round") {
          // Same keep rule as the renderer: modules touching the circle count.
          const ccx = ox + rendered.codePx / 2;
          const ccy = oy + rendered.codePx / 2;
          const nx = Math.min(Math.max(ccx, x0), x0 + mPx);
          const ny = Math.min(Math.max(ccy, y0), y0 + mPx);
          const ndx = nx - ccx;
          const ndy = ny - ccy;
          if (ndx * ndx + ndy * ndy > (rendered.codePx / 2) * (rendered.codePx / 2)) continue;
        }
        let dark = 0;
        let cells = 0;
        for (let py = 0; py < mPx; py += 2) {
          for (let px = 0; px < mPx; px += 2) {
            cells++;
            if (isDark(x0 + px, y0 + py)) dark++;
          }
        }
        fills.push(cells ? dark / cells : 0);
      }
    }
    meanGlyphFill = fills.length ? fills.reduce((a, b) => a + b, 0) / fills.length : 0;
    const thin = fills.filter((f) => f < 0.2).length;
    thinModuleShare = fills.length ? thin / fills.length : 1;
    if (meanGlyphFill < MIN_GLYPH_FILL) {
      issues.push({
        code: "glyph-too-thin",
        message: `Glyph too thin — mean cell fill ${(meanGlyphFill * 100).toFixed(0)}% < ${(MIN_GLYPH_FILL * 100).toFixed(0)}% — the modules would mis-scan. Use a bolder glyph.`,
      });
    } else if (thinModuleShare > MAX_THIN_SHARE) {
      issues.push({
        code: "glyph-uneven",
        message: `${(thinModuleShare * 100).toFixed(0)}% of dark modules read nearly empty — the glyph is uneven and would mis-scan.`,
      });
    }
  }

  // Real scan test: decode the rendered PNG and require the exact URL.
  const scan = png ? scanTestQr(rendered.png, expectedUrl) : { passed: false, decoded: null };
  if (!scan.passed) {
    issues.push({
      code: "scan-test-failed",
      message: scan.decoded
        ? `Scan test failed — decoded "${scan.decoded.slice(0, 80)}" instead of the target URL.`
        : "Scan test failed — the rendered code did not decode at all.",
    });
  }

  return {
    ok: issues.length === 0,
    issues,
    metrics: {
      contrastRatio: contrast,
      meanGlyphFill,
      thinModuleShare,
      finderMatchPct,
      quietZoneOk,
      decodeOk: scan.passed,
      decodedUrl: scan.decoded,
    },
  };
}

// ---------------------------------------------------------------------------
// Design pipeline: prompt -> spec -> glyph -> render -> validate -> scan.
// Failures return the reason PLUS a bolder auto-regenerated variant.
// ---------------------------------------------------------------------------

export interface DesignQrInput {
  targetUrl: string;
  stylePrompt: string;
  brand?: BrandContext;
  shapeMask?: ShapeMask;
  finderStyle?: FinderStyle;
  frameCta?: string;
  logoDataUrl?: string;
  /** Force a glyph kind (default: parsed from the prompt description). */
  glyphKind?: ModuleGlyphKind;
  /** Custom SVG glyph path (unit-cell viewBox 0 0 1 1) — for the LLM path. */
  customGlyphSvg?: string;
  customGlyphLabel?: string;
  glyphLlm?: QrGlyphLlm | null;
  modulePx?: number;
}

export interface DesignQrResult {
  ok: boolean;
  spec: QrStyleSpec;
  matrix: { size: number; version: number };
  png: Buffer | null;
  svg: string | null;
  validation: QrValidationResult | null;
  scanTest: { passed: boolean; decoded: string | null };
  /** True when the returned code is the bolder auto-regenerated variant. */
  regenerated: boolean;
  /** Human-readable attempt log (for the chat surface). */
  attempts: string[];
  fatal?: string;
}

const DEFAULT_FG = "#111111";
const DEFAULT_BG = "#FFFFFF";

function buildSpec(input: DesignQrInput): QrStyleSpec {
  const intent = parseStylePrompt(input.stylePrompt, input.brand);
  const finderStyle = input.finderStyle ?? "solid";
  if (finderStyle !== "solid" && finderStyle !== "rounded") {
    throw new QrDesignerError(400, `Finder style "${input.finderStyle}" is not allowed — position squares must stay intact (solid or rounded only).`);
  }
  const shapeMask = input.shapeMask ?? intent.shapeMask;
  const logoDataUrl = input.logoDataUrl ?? intent.logoDataUrl;
  let logoImagePng: Buffer | null = null;
  if (logoDataUrl) logoImagePng = decodeLogoImage(logoDataUrl);
  const glyph = designGlyph(intent.glyphHint);
  return {
    moduleGlyph: input.glyphKind ?? (/(snake|serpent|wavy|blob|star|drop|droplet|water|dot|circle|pebble)/i.test(intent.glyphHint) ? "custom-svg" : "rounded"),
    customGlyphSvg: input.customGlyphSvg,
    glyphLabel: input.customGlyphLabel ?? intent.glyphHint,
    shapeMask,
    foreground: normalizeHexColor(intent.foreground ?? DEFAULT_FG) ?? DEFAULT_FG,
    background: normalizeHexColor(intent.background ?? DEFAULT_BG) ?? DEFAULT_BG,
    finderStyle,
    logoImagePng,
    frameCta: (input.frameCta ?? intent.frameCta ?? null)?.slice(0, 60) ?? null,
    errorCorrection: "H",
    quietZoneModules: 4,
    fillFraction: glyph.fillFraction,
  };
}

function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s.trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

async function attemptRender(
  input: DesignQrInput,
  spec: QrStyleSpec,
): Promise<{ rendered: RenderedQr; matrix: QrMatrix; validation: QrValidationResult; scan: { passed: boolean; decoded: string | null } }> {
  const matrix = generateQrMatrix(input.targetUrl.trim());
  const glyph = await resolveGlyph(spec, input.glyphLlm ?? null);
  spec.fillFraction = glyph.fillFraction;
  const rendered = renderStyledQr(matrix, spec, glyph, { modulePx: input.modulePx });
  const validation = validateRenderedQr(rendered, matrix, spec, input.targetUrl.trim());
  return { rendered, matrix, validation, scan: { passed: validation.metrics.decodeOk, decoded: validation.metrics.decodedUrl } };
}

/** The bolder fallback: square modules, max contrast, no mask, no logo. */
function bolderSpec(from: QrStyleSpec): QrStyleSpec {
  const darkFirst = relativeLuminance(from.foreground) < relativeLuminance(from.background);
  return {
    ...from,
    moduleGlyph: "square",
    customGlyphSvg: undefined,
    glyphLabel: "classic squares (bolder fallback)",
    shapeMask: "square",
    foreground: darkFirst ? from.foreground : from.background,
    background: darkFirst ? from.background : from.foreground,
    logoImagePng: null,
    fillFraction: 1,
  };
}

export async function designQr(input: DesignQrInput): Promise<DesignQrResult> {
  const attempts: string[] = [];
  if (!input.targetUrl || !isHttpUrl(input.targetUrl)) {
    return {
      ok: false, spec: buildSafeSpec(), matrix: { size: 0, version: 0 }, png: null, svg: null,
      validation: null, scanTest: { passed: false, decoded: null }, regenerated: false, attempts,
      fatal: "targetUrl must be an http(s) URL.",
    };
  }
  let spec: QrStyleSpec;
  try {
    spec = buildSpec(input);
  } catch (err) {
    return {
      ok: false, spec: buildSafeSpec(), matrix: { size: 0, version: 0 }, png: null, svg: null,
      validation: null, scanTest: { passed: false, decoded: null }, regenerated: false, attempts,
      fatal: err instanceof Error ? err.message : "Could not parse the style request.",
    };
  }

  try {
    const first = await attemptRender(input, spec);
    attempts.push(
      `Attempt 1 (${spec.glyphLabel}, ${spec.shapeMask} mask): ` +
        (first.validation.ok ? "validation passed, scan test passed." : `failed — ${first.validation.issues.map((i) => i.message).join(" ")}`),
    );
    if (first.validation.ok) {
      return {
        ok: true, spec, matrix: { size: first.matrix.size, version: first.matrix.version },
        png: first.rendered.png, svg: first.rendered.svg, validation: first.validation,
        scanTest: first.scan, regenerated: false, attempts,
      };
    }
    // Failure path: regenerate a bolder variant and report both.
    const bold = bolderSpec(spec);
    const second = await attemptRender(input, bold);
    attempts.push(
      `Attempt 2 (bolder fallback — square modules, no mask, no logo): ` +
        (second.validation.ok ? "validation passed, scan test passed." : `failed — ${second.validation.issues.map((i) => i.message).join(" ")}`),
    );
    if (second.validation.ok) {
      return {
        ok: true, spec: bold, matrix: { size: second.matrix.size, version: second.matrix.version },
        png: second.rendered.png, svg: second.rendered.svg, validation: second.validation,
        scanTest: second.scan, regenerated: true, attempts,
      };
    }
    return {
      ok: false, spec, matrix: { size: first.matrix.size, version: first.matrix.version },
      png: null, svg: null, validation: second.validation, scanTest: second.scan,
      regenerated: false, attempts,
    };
  } catch (err) {
    return {
      ok: false, spec, matrix: { size: 0, version: 0 }, png: null, svg: null,
      validation: null, scanTest: { passed: false, decoded: null }, regenerated: false, attempts,
      fatal: err instanceof Error ? err.message : "Render failed.",
    };
  }
}

function buildSafeSpec(): QrStyleSpec {
  return {
    moduleGlyph: "square",
    glyphLabel: "classic squares",
    shapeMask: "square",
    foreground: DEFAULT_FG,
    background: DEFAULT_BG,
    finderStyle: "solid",
    logoImagePng: null,
    frameCta: null,
    errorCorrection: "H",
    quietZoneModules: 4,
    fillFraction: 1,
  };
}

// ---------------------------------------------------------------------------
// Print-lock: the verified asset gets a sha256 hash the per-buy approval
// object can bind (spec §4 tracking_links qr_png_url / S3 creative_hashes).
//
// The store function is injectable so tests can stub it (no live DB needed).
// ---------------------------------------------------------------------------

/** SHA-256 hex of the exact PNG bytes — the binding hash for approvals. */
export function computeQrAssetHash(pngBytes: Buffer | Uint8Array): string {
  return createHash("sha256").update(pngBytes).digest("hex");
}

export interface QrPrintLock {
  hash: string;
  pngPath: string;
  svgPath: string;
  pngFileId: string;
  svgFileId: string;
  /** Serving URL for the print-locked PNG (bind into tracking_links.qr_png_url). */
  qrPngUrl: string;
  targetUrl: string;
  validatedAt: string;
}

export interface QrStoreFile {
  (workspaceId: string, logicalPath: string, bytes: Buffer, mimeType: string, createdBy: string): Promise<{ fileId: string }>;
}

export async function defaultStoreQrFile(
  workspaceId: string,
  logicalPath: string,
  bytes: Buffer,
  mimeType: string,
  createdBy: string,
): Promise<{ fileId: string }> {
  // Idempotent: the logical path is content-addressed (sha256 of the PNG
  // bytes), so an existing live file at this path is byte-identical to what
  // we would write. Re-designing the same QR must return the existing asset
  // instead of 500ing on a path conflict.
  const { prisma } = await import("@/lib/prisma");
  const existing = await prisma.workspaceFile.findFirst({
    where: { workspaceId, logicalPath, trashedAt: null },
    select: { id: true },
  });
  if (existing) return { fileId: existing.id };
  const { writeFile } = await import("@/lib/filesystem/service");
  const file = await writeFile({ workspaceId, logicalPath, kind: "file", bytes, mimeType, createdBy });
  return { fileId: file.id };
}

export function qrAssetDownloadUrl(hash: string): string {
  return `/api/media/qr/asset/${hash}`;
}

/**
 * Print-lock a designed QR. HARD GATE: only a design whose validation passed
 * AND whose real scan test decoded the exact target URL can be locked. The
 * caller audits the lock (auditStudio) — the engine stays dependency-light.
 */
export async function printLockQr(opts: {
  workspaceId: string;
  result: DesignQrResult;
  targetUrl: string;
  createdBy: string;
  storeFile?: QrStoreFile;
}): Promise<QrPrintLock> {
  const { workspaceId, result, targetUrl, createdBy } = opts;
  if (!result.ok || !result.png || !result.svg) {
    throw new QrDesignerError(422, "Cannot print-lock: the design did not pass validation.");
  }
  if (!result.validation?.ok || !result.scanTest.passed || result.scanTest.decoded !== targetUrl.trim()) {
    throw new QrDesignerError(422, "Cannot print-lock: the styled code is not scan-verified against the exact target URL.");
  }
  const hash = computeQrAssetHash(result.png);
  const store = opts.storeFile ?? defaultStoreQrFile;
  const pngPath = `/files/studio/qr/${hash}.png`;
  const svgPath = `/files/studio/qr/${hash}.svg`;
  const pngFile = await store(workspaceId, pngPath, result.png, "image/png", createdBy);
  const svgFile = await store(workspaceId, svgPath, Buffer.from(result.svg, "utf8"), "image/svg+xml", createdBy);
  return {
    hash,
    pngPath,
    svgPath,
    pngFileId: pngFile.fileId,
    svgFileId: svgFile.fileId,
    qrPngUrl: qrAssetDownloadUrl(hash),
    targetUrl: targetUrl.trim(),
    validatedAt: new Date().toISOString(),
  };
}
