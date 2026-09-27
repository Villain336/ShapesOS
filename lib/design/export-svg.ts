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
//  - Charts are drawn with deterministic layout math defined here
//    (DEFAULT_CHART_BOX, bar/line/pie geometry). There is no shared
//    canvas geometry yet — when the canvas chart renderer lands it should
//    import these layout helpers so both outputs agree.
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
import { validateDesignDocument } from "./validate";

export type SvgExportResult = { ok: true; svg: string } | { ok: false; error: string };

export interface SvgExportOptions {
  /** Element id -> data URL (or URL) to use for image elements. */
  imageSources?: Record<string, string>;
}

/** Default chart box (element-local, px). Charts have no width/height in
 *  the schema, so this constant IS the layout contract — the canvas
 *  renderer should import and use it too. */
export const DEFAULT_CHART_BOX = { width: 360, height: 240 } as const;

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

function chartColors(el: ChartElement, i: number): string {
  return el.colors.length > 0 ? el.colors[i % el.colors.length]! : "#7c3aed";
}

function chartValueLabel(x: number, y: number, value: number): string {
  return `<text x="${formatNumber(x)}" y="${formatNumber(y)}" font-size="11" fill="#57534e" text-anchor="middle">${escapeXml(String(value))}</text>`;
}

/** Bar chart geometry in element-local coords. */
export function barChartSvg(el: ChartElement): string {
  const { width, height } = DEFAULT_CHART_BOX;
  const pad = 16;
  const plotW = width - pad * 2;
  const plotH = height - pad * 2 - 18; // room for axis labels
  const n = el.values.length;
  if (n === 0) return "";
  const max = Math.max(1, ...el.values.map((v) => Math.max(0, v)));
  const slot = plotW / n;
  const barW = Math.min(slot * 0.6, 64);
  let out = "";
  for (let i = 0; i < n; i++) {
    const v = Math.max(0, el.values[i]!);
    const h = (v / max) * plotH;
    const bx = pad + slot * i + (slot - barW) / 2;
    const by = pad + plotH - h;
    out += `<rect x="${formatNumber(bx)}" y="${formatNumber(by)}" width="${formatNumber(barW)}" height="${formatNumber(h)}" fill="${escapeXml(chartColors(el, i))}"/>`;
    out += `<text x="${formatNumber(bx + barW / 2)}" y="${formatNumber(pad + plotH + 14)}" font-size="11" fill="#57534e" text-anchor="middle">${escapeXml(el.labels[i] ?? "")}</text>`;
    if (el.showValues) out += chartValueLabel(bx + barW / 2, by - 5, el.values[i]!);
  }
  return out;
}

/** Line chart geometry in element-local coords. */
export function lineChartSvg(el: ChartElement): string {
  const { width, height } = DEFAULT_CHART_BOX;
  const pad = 16;
  const plotW = width - pad * 2;
  const plotH = height - pad * 2 - 18;
  const n = el.values.length;
  if (n === 0) return "";
  const min = Math.min(...el.values);
  const max = Math.max(...el.values);
  const span = max - min || 1;
  const px = (i: number) => pad + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const py = (v: number) => pad + plotH - ((v - min) / span) * plotH;
  const color = chartColors(el, 0);
  let out = `<polyline points="${el.values.map((v, i) => `${formatNumber(px(i))},${formatNumber(py(v))}`).join(" ")}" fill="none" stroke="${escapeXml(color)}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`;
  for (let i = 0; i < n; i++) {
    out += `<circle cx="${formatNumber(px(i))}" cy="${formatNumber(py(el.values[i]!))}" r="3.5" fill="${escapeXml(color)}"/>`;
    out += `<text x="${formatNumber(px(i))}" y="${formatNumber(pad + plotH + 14)}" font-size="11" fill="#57534e" text-anchor="middle">${escapeXml(el.labels[i] ?? "")}</text>`;
    if (el.showValues) out += chartValueLabel(px(i), py(el.values[i]!) - 8, el.values[i]!);
  }
  return out;
}

/** Pie chart geometry in element-local coords. */
export function pieChartSvg(el: ChartElement): string {
  const { width, height } = DEFAULT_CHART_BOX;
  const n = el.values.length;
  const total = el.values.reduce((a, v) => a + Math.max(0, v), 0);
  if (n === 0 || total <= 0) return "";
  const cx = width / 2;
  const cy = height / 2;
  const r = Math.min(width, height) / 2 - 12;
  let out = "";
  let angle = -Math.PI / 2;
  for (let i = 0; i < n; i++) {
    const frac = Math.max(0, el.values[i]!) / total;
    const a2 = angle + frac * Math.PI * 2;
    const large = frac > 0.5 ? 1 : 0;
    const x1 = cx + r * Math.cos(angle);
    const y1 = cy + r * Math.sin(angle);
    const x2 = cx + r * Math.cos(a2);
    const y2 = cy + r * Math.sin(a2);
    out += `<path d="M ${formatNumber(cx)},${formatNumber(cy)} L ${formatNumber(x1)},${formatNumber(y1)} A ${formatNumber(r)},${formatNumber(r)} 0 ${large},1 ${formatNumber(x2)},${formatNumber(y2)} Z" fill="${escapeXml(chartColors(el, i))}"/>`;
    if (el.showValues && frac > 0.06) {
      const mid = angle + (frac * Math.PI * 2) / 2;
      out += `<text x="${formatNumber(cx + (r * 0.65) * Math.cos(mid))}" y="${formatNumber(cy + (r * 0.65) * Math.sin(mid))}" font-size="11" fill="#ffffff" text-anchor="middle">${escapeXml(String(el.values[i]!))}</text>`;
    }
    angle = a2;
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
