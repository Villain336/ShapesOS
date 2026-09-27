// Marketr — Phase 11 "Canvas": FEATURE 4 — document → SVG serializer.
//
// Pure functions: no DOM, no Konva, no browser APIs (except the `qrcode`
// math used to compute QR module grids — `QRCode.create` is pure JS, no
// canvas, and ships a browser-safe entry via the package's `browser` field).
// Safe to import in client components and in node:test unit tests.
//
// Design decisions:
//  - Serialize from the DesignDocument, NOT the Konva stage. Text stays
//    <text>, shapes stay <rect>/<ellipse>/<path> — real vector output.
//  - Defensive: unknown/future element types are skipped with an XML
//    comment, never a crash. Invalid documents are rejected with a result
//    object, never a throw.
//  - Charts are drawn with the shared chart-math layout models — the same
//    models the Konva canvas renderer uses — so canvas and SVG agree.
//  - Images embed as data URLs. A data: URL src is embedded verbatim.
//    Callers may pre-resolve remote URLs into data URLs via the
//    `imageSources` option (id -> data URL); unresolved remote URLs are kept
//    as external <image href> with a warning comment — they will not render
//    offline or behind CORS. SIZE CAVEAT: base64 inflates images ~33%; a
//    design with several photographic images can produce a multi-MB SVG.
//  - Text wrapping: Konva wraps at a pixel `width`; that layout is not
//    replicated here — explicit line breaks are preserved, word wrap is
//    not. Font metrics are approximated (baseline = y + 0.8 * fontSize).
//  - Exported SVGs reference font-family names; the viewer must have the
//    fonts installed (no font embedding).
//
// Print-grade PDF: deliberately NOT built. jsPDF is RGB-only (no ICC
// OutputIntent, no DeviceCMYK operators), so CMYK/bleed/crop-marks would be
// fake. See the comment above the pdf branch in Toolbar.tsx for what a real
// print pipeline would require.

import QRCode from "qrcode";
import {
  type ChartElement,
  type DesignDocument,
  type DesignElement,
  type EllipseElement,
  type ImageElement,
  type LineElement,
  type QrElement,
  type RectElement,
  type SvgElement,
  type TextElement,
} from "./types";
import {
  barModel,
  lineModel,
  pieSlices,
  pieLayout,
  chartSize,
  formatChartValue,
  truncateLabel,
  withAlpha,
} from "./chart-math";
import { validateDesignDocument } from "./validate";

export type SvgExportResult = { ok: true; svg: string } | { ok: false; error: string };

export interface SvgExportOptions {
  /** Element id -> data URL (or URL) to use for image elements. */
  imageSources?: Record<string, string>;
}

/** Default chart box (element-local, px). Charts have no width/height in
 *  the schema, so this constant IS the layout contract — the canvas
 *  renderer should import and use it too. */

/** Approx. baseline offset (Konva y = top of text box). */
const BASELINE_RATIO = 0.8;

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Round to 2 decimals, strip float noise. */
export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const r = Math.round(n * 100) / 100;
  return Object.is(r, -0) ? "0" : String(r);
}

function sanitizeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "_");
}

/** `design name` + page -> safe filename, e.g. "Summer Sale-Page 1.svg". */
export function svgFilename(designName: string, pageName: string): string {
  const clean = (s: string) =>
    (s || "").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, " ") || "design";
  return `${clean(designName)}-${clean(pageName)}.svg`;
}

// ── Shared attribute helpers ─────────────────────────────────────────────

function transformAttr(el: DesignElement): string {
  return el.rotation ? ` transform="rotate(${formatNumber(el.rotation)} ${formatNumber(el.x)} ${formatNumber(el.y)})"` : "";
}

function opacityAttr(el: DesignElement): string {
  return el.opacity < 1 ? ` opacity="${formatNumber(el.opacity)}"` : "";
}

function fontWeightStyle(fontStyle: TextElement["fontStyle"]): string {
  const weight = fontStyle === "bold" || fontStyle === "bold-italic" ? ' font-weight="bold"' : "";
  const style = fontStyle === "italic" || fontStyle === "bold-italic" ? ' font-style="italic"' : "";
  return weight + style;
}

// ── Text ─────────────────────────────────────────────────────────────────

function textFragmentRuns(el: TextElement): string {
  const baseSize = el.fontSize;
  const runs: string[] = [];
  const push = (
    text: string,
    fontFamily: string | undefined,
    fontSize: number | undefined,
    fontStyle: TextElement["fontStyle"] | undefined,
    fill: string | undefined,
  ) => {
    const size = fontSize ?? baseSize;
    for (const [i, line] of text.split("\n").entries()) {
      const dy = i === 0 ? "" : ` dy="${formatNumber(size * el.lineHeight)}"`;
      runs.push(
        `<tspan${fontFamily && fontFamily !== el.fontFamily ? ` font-family="${escapeXml(fontFamily)}"` : ""}${size !== baseSize ? ` font-size="${formatNumber(size)}"` : ""}${fontWeightStyle(fontStyle ?? el.fontStyle)}${fill && fill !== el.fill ? ` fill="${escapeXml(fill)}"` : ""}${dy} xml:space="preserve">${escapeXml(line)}</tspan>`,
      );
    }
  };
  if (el.fragments && el.fragments.length > 0) {
    for (const f of el.fragments) push(f.text, f.fontFamily, f.fontSize, f.fontStyle, f.fill);
  } else {
    push(el.text, undefined, undefined, undefined, undefined);
  }
  return runs.join("");
}

function textToSvg(el: TextElement): string {
  const anchorX =
    el.align === "center" && el.width !== undefined
      ? el.x + el.width / 2
      : el.align === "right" && el.width !== undefined
        ? el.x + el.width
        : el.x;
  const anchor = el.align === "center" ? "middle" : el.align === "right" ? "end" : "start";
  const attrs =
    `x="${formatNumber(anchorX)}" y="${formatNumber(el.y + el.fontSize * BASELINE_RATIO)}" ` +
    `font-family="${escapeXml(el.fontFamily)}" font-size="${formatNumber(el.fontSize)}"` +
    fontWeightStyle(el.fontStyle) +
    ` fill="${escapeXml(el.fill)}" text-anchor="${anchor}"` +
    (el.letterSpacing ? ` letter-spacing="${formatNumber(el.letterSpacing)}"` : "") +
    transformAttr(el) +
    opacityAttr(el);

  if (el.textPath) {
    // Konva TextPath data is node-local; the translate() re-applies x/y.
    // (Fragments are ignored in path mode, per the schema contract.)
    const pathId = `tp-${sanitizeId(el.id)}`;
    const textAttrs =
      `font-family="${escapeXml(el.fontFamily)}" font-size="${formatNumber(el.fontSize)}"` +
      fontWeightStyle(el.fontStyle) +
      ` fill="${escapeXml(el.fill)}"` +
      (el.letterSpacing ? ` letter-spacing="${formatNumber(el.letterSpacing)}"` : "") +
      opacityAttr(el);
    return (
      `<defs><path id="${pathId}" d="${escapeXml(el.textPath)}" fill="none"/></defs>` +
      `<g transform="translate(${formatNumber(el.x)},${formatNumber(el.y)})${el.rotation ? ` rotate(${formatNumber(el.rotation)})` : ""}">` +
      `<text ${textAttrs} x="0" y="${formatNumber(el.fontSize * BASELINE_RATIO)}"><textPath href="#${pathId}">${escapeXml(el.text)}</textPath></text></g>`
    );
  }
  return `<text ${attrs}>${textFragmentRuns(el)}</text>`;
}

// ── Rect / ellipse ───────────────────────────────────────────────────────

function gradientDef(el: RectElement | EllipseElement): string {
  if (!el.gradient) return "";
  const [from, to] = el.gradient;
  const id = `grad-${sanitizeId(el.id)}`;
  return (
    `<defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="0">` +
    `<stop offset="0" stop-color="${escapeXml(from)}"/>` +
    `<stop offset="1" stop-color="${escapeXml(to)}"/>` +
    `</linearGradient></defs>`
  );
}

function strokeAttrs(stroke: string | undefined, strokeWidth: number | undefined): string {
  if (!stroke) return "";
  return ` stroke="${escapeXml(stroke)}" stroke-width="${formatNumber(strokeWidth ?? 1)}"`;
}

function rectToSvg(el: RectElement): string {
  const fill = el.gradient ? ` fill="url(#grad-${sanitizeId(el.id)})"` : ` fill="${escapeXml(el.fill)}"`;
  return (
    gradientDef(el) +
    `<rect x="${formatNumber(el.x)}" y="${formatNumber(el.y)}" width="${formatNumber(el.width)}" height="${formatNumber(el.height)}"` +
    (el.cornerRadius ? ` rx="${formatNumber(el.cornerRadius)}"` : "") +
    fill +
    strokeAttrs(el.stroke, el.strokeWidth) +
    transformAttr(el) +
    opacityAttr(el) +
    `/>`
  );
}

function ellipseToSvg(el: EllipseElement): string {
  // Konva Ellipse x/y is the center — matches SVG cx/cy.
  const fill = el.gradient ? ` fill="url(#grad-${sanitizeId(el.id)})"` : ` fill="${escapeXml(el.fill)}"`;
  return (
    gradientDef(el) +
    `<ellipse cx="${formatNumber(el.x)}" cy="${formatNumber(el.y)}" rx="${formatNumber(el.radiusX)}" ry="${formatNumber(el.radiusY)}"` +
    fill +
    strokeAttrs(el.stroke, el.strokeWidth) +
    transformAttr(el) +
    opacityAttr(el) +
    `/>`
  );
}

// ── Line ─────────────────────────────────────────────────────────────────

function lineToSvg(el: LineElement): string {
  const pts: string[] = [];
  for (let i = 0; i + 1 < el.points.length; i += 2) {
    pts.push(`${formatNumber(el.x + el.points[i]!)},${formatNumber(el.y + el.points[i + 1]!)}`);
  }
  return (
    `<polyline points="${pts.join(" ")}" fill="none" stroke="${escapeXml(el.stroke)}" ` +
    `stroke-width="${formatNumber(el.strokeWidth)}" stroke-linecap="round"` +
    (el.dash && el.dash.length > 0 ? ` stroke-dasharray="${el.dash.map(formatNumber).join(" ")}"` : "") +
    transformAttr(el) +
    opacityAttr(el) +
    `/>`
  );
}

// ── SVG icon path ────────────────────────────────────────────────────────

function svgPathToSvg(el: SvgElement): string {
  // 24x24 viewBox icon convention (matches the Konva renderer scale).
  if (el.width <= 0 || el.height <= 0) return `<!-- svg element ${escapeXml(el.id)} skipped: non-positive size -->`;
  return (
    `<path d="${escapeXml(el.path)}" fill="${escapeXml(el.fill)}"` +
    ` transform="translate(${formatNumber(el.x)},${formatNumber(el.y)}) scale(${formatNumber(el.width / 24)},${formatNumber(el.height / 24)})"` +
    opacityAttr(el) +
    `/>`
  );
}

// ── Image ────────────────────────────────────────────────────────────────

function imageToSvg(el: ImageElement, opts: SvgExportOptions): string {
  const src = opts.imageSources?.[el.id] ?? el.src;
  const isDataUrl = src.startsWith("data:");
  const warning = isDataUrl
    ? ""
    : `<!-- image ${escapeXml(el.id)}: external href (may not render offline / behind CORS) -->`;
  const clip =
    el.cornerRadius > 0
      ? `<defs><clipPath id="clip-${sanitizeId(el.id)}"><rect x="${formatNumber(el.x)}" y="${formatNumber(el.y)}" width="${formatNumber(el.width)}" height="${formatNumber(el.height)}" rx="${formatNumber(el.cornerRadius)}"/></clipPath></defs>`
      : "";
  const img =
    `<image href="${escapeXml(src)}" x="${formatNumber(el.x)}" y="${formatNumber(el.y)}" ` +
    `width="${formatNumber(el.width)}" height="${formatNumber(el.height)}" preserveAspectRatio="none"` +
    transformAttr(el) +
    opacityAttr(el) +
    `/>`;  return warning + clip + (el.cornerRadius > 0 ? `<g clip-path="url(#clip-${sanitizeId(el.id)})">${img}</g>` : img);
}

// ── Chart ────────────────────────────────────────────────────────────────
// Geometry comes from the shared chart-math models (same as the Konva canvas
// renderer), so canvas and SVG output always agree.

const CHART_FONT = "Inter";
const CHART_LABEL_FILL = "#78716c";
const CHART_VALUE_FILL = "#44403c";
const CHART_TICK_FILL = "#a8a29e";
const CHART_GRID = "#eceae6";
const CHART_BASELINE = "#d8d4cf";

function chartText(
  x: number,
  y: number,
  content: string,
  opts: { size?: number; fill?: string; anchor?: string; weight?: number } = {},
): string {
  const { size = 11, fill = CHART_LABEL_FILL, anchor = "middle", weight } = opts;
  return `<text x="${formatNumber(x)}" y="${formatNumber(y)}" font-family="${CHART_FONT}" font-size="${size}"${weight ? ` font-weight="${weight}"` : ""} fill="${escapeXml(fill)}" text-anchor="${anchor}">${escapeXml(content)}</text>`;
}

/** Gridlines + y-axis tick labels, mirroring ChartNode's Gridlines. */
function chartGridSvg(m: { plot: { x: number; y: number; w: number; h: number }; ticks: { value: number; y: number }[] }): string {
  let out = "";
  for (const t of m.ticks) {
    const stroke = t.value === 0 ? CHART_BASELINE : CHART_GRID;
    out += `<line x1="${formatNumber(m.plot.x)}" y1="${formatNumber(t.y)}" x2="${formatNumber(m.plot.x + m.plot.w)}" y2="${formatNumber(t.y)}" stroke="${stroke}" stroke-width="1"/>`;
    out += chartText(m.plot.x - 6, t.y + 4, formatChartValue(t.value), {
      fill: CHART_TICK_FILL,
      anchor: "end",
    });
  }
  return out;
}

function polylinePoints(pts: number[]): string {
  return pts.reduce(
    (acc, p, i) => acc + (i > 0 ? (i % 2 === 0 ? " " : ",") : "") + formatNumber(p),
    "",
  );
}

/** Bar chart geometry in element-local coords. */
export function barChartSvg(el: ChartElement): string {
  const { w, h } = chartSize(el);
  if (el.values.length === 0) return "";
  const m = barModel(el.labels, el.values, el.colors, w, h);
  let out = chartGridSvg(m);
  for (let i = 0; i < m.bars.length; i++) {
    const b = m.bars[i]!;
    out += `<rect x="${formatNumber(b.x)}" y="${formatNumber(b.y)}" width="${formatNumber(b.w)}" height="${formatNumber(b.h)}" rx="6" fill="${escapeXml(b.color)}"/>`;
    if (el.showValues) {
      out += chartText(b.cx, b.labelY, formatChartValue(b.value), {
        size: 12,
        fill: CHART_VALUE_FILL,
        weight: 600,
      });
    }
    if (i % m.labelStep === 0) {
      out += chartText(b.cx, m.plot.y + m.plot.h + 8, truncateLabel(b.label, 12));
    }
  }
  return out;
}

/** Line chart geometry in element-local coords. */
export function lineChartSvg(el: ChartElement): string {
  const { w, h } = chartSize(el);
  if (el.values.length === 0) return "";
  const m = lineModel(el.labels, el.values, el.colors, w, h);
  let out = chartGridSvg(m);
  if (m.areaPoints.length > 3) {
    out += `<polygon points="${polylinePoints(m.areaPoints)}" fill="${escapeXml(withAlpha(m.color, 0.12))}"/>`;
  }
  if (m.points.length > 1) {
    out += `<polyline points="${polylinePoints(m.points)}" fill="none" stroke="${escapeXml(m.color)}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>`;
  }
  for (const d of m.dots) {
    out += `<circle cx="${formatNumber(d.x)}" cy="${formatNumber(d.y)}" r="5.5" fill="#ffffff" stroke="${escapeXml(d.color)}" stroke-width="3"/>`;
    if (el.showValues) {
      out += chartText(d.x, d.y - 14, formatChartValue(d.value), {
        size: 12,
        fill: CHART_VALUE_FILL,
        weight: 600,
      });
    }
  }
  const step = m.categories.length > 12 ? 2 : 1;
  for (let i = 0; i < m.categories.length; i++) {
    if (i % step !== 0) continue;
    const c = m.categories[i]!;
    out += chartText(c.x, m.plot.y + m.plot.h + 8, truncateLabel(c.label, 12));
  }
  return out;
}

/** Pie chart geometry in element-local coords. */
export function pieChartSvg(el: ChartElement): string {
  const { w, h } = chartSize(el);
  const slices = pieSlices(el.labels, el.values, el.colors);
  if (slices.length === 0) return "";
  const L = pieLayout(w, h, slices.length);
  let out = "";
  for (const s of slices) {
    if (s.sweepDeg <= 0) continue;
    const a1 = (s.startDeg * Math.PI) / 180;
    const a2 = ((s.startDeg + s.sweepDeg) * Math.PI) / 180;
    const x1 = L.cx + L.r * Math.cos(a1);
    const y1 = L.cy + L.r * Math.sin(a1);
    const x2 = L.cx + L.r * Math.cos(a2);
    const y2 = L.cy + L.r * Math.sin(a2);
    const large = s.sweepDeg > 180 ? 1 : 0;
    out += `<path d="M ${formatNumber(L.cx)},${formatNumber(L.cy)} L ${formatNumber(x1)},${formatNumber(y1)} A ${formatNumber(L.r)},${formatNumber(L.r)} 0 ${large},1 ${formatNumber(x2)},${formatNumber(y2)} Z" fill="${escapeXml(s.color)}" stroke="#ffffff" stroke-width="2"/>`;
    if (s.fraction >= 0.06) {
      const mid = ((s.startDeg + s.sweepDeg / 2) * Math.PI) / 180;
      out += chartText(L.cx + Math.cos(mid) * L.r * 0.62, L.cy + Math.sin(mid) * L.r * 0.62, `${Math.round(s.fraction * 100)}%`, {
        fill: "#ffffff",
        weight: 600,
      });
    }
  }
  for (let i = 0; i < slices.length; i++) {
    const s = slices[i]!;
    const y = 44 + i * L.rowH;
    out += `<circle cx="${formatNumber(L.legendX + 6)}" cy="${formatNumber(y + 7)}" r="5" fill="${escapeXml(s.color)}"/>`;
    out += chartText(L.legendX + 18, y + 14, truncateLabel(s.label, 16), {
      size: 12,
      fill: CHART_VALUE_FILL,
      anchor: "start",
    });
    out += chartText(L.legendX + L.legendW - 4, y + 14, formatChartValue(s.value), {
      size: 12,
      anchor: "end",
    });
  }
  return out;
}
export function chartToSvg(el: ChartElement): string {
  const body =
    el.chartType === "bar" ? barChartSvg(el) : el.chartType === "line" ? lineChartSvg(el) : pieChartSvg(el);
  if (!body) return `<!-- chart ${escapeXml(el.id)} skipped: no drawable data -->`;
  // translate() re-applies x/y; the inner rotate() is about the local
  // origin, matching Konva's rotate-about-node-origin.
  return (
    `<g transform="translate(${formatNumber(el.x)},${formatNumber(el.y)})${el.rotation ? ` rotate(${formatNumber(el.rotation)})` : ""}"${opacityAttr(el)}>` +
    `${body}</g>`
  );
}

// ── QR ───────────────────────────────────────────────────────────────────

export interface QrModuleGrid {
  size: number; // modules per side (excludes quiet zone)
  dark: (row: number, col: number) => boolean;
}

/** Pure QR matrix computation (error correction M). Throws on bad input —
 *  callers that want a never-throw path should catch. */
export function qrModules(payload: string): QrModuleGrid {
  const qr = QRCode.create(payload, { errorCorrectionLevel: "M" });
  const size: number = qr.modules.size;
  const cells: boolean[][] = [];
  for (let r = 0; r < size; r++) {
    const row: boolean[] = [];
    for (let c = 0; c < size; c++) row.push(Boolean(qr.modules.get(r, c)));
    cells.push(row);
  }
  return { size, dark: (row, col) => cells[row]?.[col] ?? false };
}

export function qrToSvg(el: QrElement): string {
  let grid: QrModuleGrid;
  try {
    grid = qrModules(el.payload);
  } catch {
    return `<!-- qr ${escapeXml(el.id)} skipped: payload could not be encoded -->`;
  }
  const quiet = 4; // modules of quiet zone, folded INSIDE el.size
  const cell = el.size / (grid.size + quiet * 2);
  let modules = "";
  for (let r = 0; r < grid.size; r++) {
    let runStart = -1;
    for (let c = 0; c <= grid.size; c++) {
      const dark = c < grid.size && grid.dark(r, c);
      if (dark && runStart === -1) runStart = c;
      if (!dark && runStart !== -1) {
        modules += `<rect x="${formatNumber((quiet + runStart) * cell)}" y="${formatNumber((quiet + r) * cell)}" width="${formatNumber((c - runStart) * cell)}" height="${formatNumber(cell)}"/>`;
        runStart = -1;
      }
    }
  }
  return (
    `<g transform="translate(${formatNumber(el.x)},${formatNumber(el.y)})${el.rotation ? ` rotate(${formatNumber(el.rotation)})` : ""}"${opacityAttr(el)}>` +
    `<rect x="0" y="0" width="${formatNumber(el.size)}" height="${formatNumber(el.size)}" fill="${escapeXml(el.background)}"/>` +
    `<g fill="${escapeXml(el.foreground)}">${modules}</g></g>`
  );
}

// ── Element dispatch ─────────────────────────────────────────────────────

function visibleElements(el: DesignElement): boolean {
  return el.visible;
}

/** Serialize one element. Unknown/future types -> XML comment, never throws. */
export function elementToSvg(el: DesignElement, opts: SvgExportOptions): string {
  if (!visibleElements(el)) return "";
  // Capture before the exhaustive switch narrows `el` to `never`.
  const elId = el.id;
  const elType = (el as { type?: unknown }).type;
  try {
    switch (el.type) {
      case "text":
        return textToSvg(el as TextElement);
      case "rect":
        return rectToSvg(el as RectElement);
      case "ellipse":
        return ellipseToSvg(el as EllipseElement);
      case "line":
        return lineToSvg(el as LineElement);
      case "svg":
        return svgPathToSvg(el as SvgElement);
      case "image":
        return imageToSvg(el as ImageElement, opts);
      case "chart":
        return chartToSvg(el as ChartElement);
      case "qr":
        return qrToSvg(el as QrElement);
      default:
        return `<!-- unknown element type "${escapeXml(String(elType))}" (id ${escapeXml(elId)}) skipped -->`;
    }
  } catch (err) {
    return `<!-- element ${escapeXml(elId)} failed to serialize: ${escapeXml(err instanceof Error ? err.message : String(err))} -->`;
  }
}

// ── Page / document ──────────────────────────────────────────────────────

/** Serialize one page of a (validated) document to a standalone SVG string. */
export function exportPageToSvg(
  doc: unknown,
  pageId: string,
  opts: SvgExportOptions = {},
): SvgExportResult {
  const validated = validateDesignDocument(doc);
  if (!validated.ok) return { ok: false, error: validated.error };
  const page = validated.doc.pages.find((p) => p.id === pageId);
  if (!page) return { ok: false, error: `page not found: ${pageId}` };

  const body = page.elements.map((el) => elementToSvg(el, opts)).filter(Boolean).join("\n");
  const svg =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!-- Exported from Marketr Canvas (schema v${validated.doc.schemaVersion}) — page "${escapeXml(page.name)}" -->\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" width="${formatNumber(page.width)}" height="${formatNumber(page.height)}" viewBox="0 0 ${formatNumber(page.width)} ${formatNumber(page.height)}">\n` +
    `<rect x="0" y="0" width="${formatNumber(page.width)}" height="${formatNumber(page.height)}" fill="${escapeXml(page.background)}"/>\n` +
    (body ? body + "\n" : "") +
    `</svg>`;
  return { ok: true, svg };
}
