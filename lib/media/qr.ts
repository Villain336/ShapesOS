// Marketr — Phase 5 A1: QR rendering (brand-customizable, scannability-verified).
//
// CONTRACT WITH THE QR-DESIGNER TRACK (lib/studio/qr-designer.ts):
//   - `encodeQr(data, opts)` produces the DATA LAYER: QrMatrix (the real QR
//     matrix — the designer track must NEVER touch encoded data).
//   - `renderQr(matrix, style)` is the ARTWORK-LAYER primitive the designer
//     calls: it tiles styled glyphs/colors/frames/logos onto a given matrix
//     and runs automated scannability validation before returning.
//   - Every styled code must ALSO pass a real scan test before print-lock
//     (designer track's job); styled codes that fail stay out of the
//     approval object.
//
// Exports PNG (via sharp, high-res) + vector SVG. Every render runs
// automated validation — contrast ratio, quiet zone, finder integrity — and
// returns a scannability verdict. Fail-closed: renderQr throws when the
// verdict fails and `strict` is true (default).

import QRCode from "qrcode";
import sharp from "sharp";

// ---------------------------------------------------------------------------
// Data layer
// ---------------------------------------------------------------------------

export type QrErrorCorrection = "L" | "M" | "Q" | "H";

/** The real QR matrix. Opaque to styling: artwork code never mutates this. */
export interface QrMatrix {
  version: number;
  size: number;
  errorCorrection: QrErrorCorrection;
  /** dark(row, col) — true = dark module. */
  dark: (row: number, col: number) => boolean;
}

export function encodeQr(
  data: string,
  opts: { errorCorrection?: QrErrorCorrection } = {},
): QrMatrix {
  if (!data) throw new Error("encodeQr: data must be non-empty");
  const ec = opts.errorCorrection ?? "M";
  const qr = QRCode.create(data, { errorCorrectionLevel: ec });
  const size: number = qr.modules.size;
  const cells: boolean[][] = [];
  for (let r = 0; r < size; r++) {
    const row: boolean[] = [];
    for (let c = 0; c < size; c++) row.push(Boolean(qr.modules.get(r, c)));
    cells.push(row);
  }
  return {
    version: qr.version,
    size,
    errorCorrection: ec,
    dark: (row, col) => cells[row]?.[col] ?? false,
  };
}

// ---------------------------------------------------------------------------
// Artwork layer
// ---------------------------------------------------------------------------

export type DotStyle = "square" | "rounded" | "dots";
export type EyeStyle = "square" | "rounded" | "circle";

export interface QrFrame {
  /** Printable CTA under the code, e.g. "Scan for 20% off". */
  text: string;
  textColor?: string;
  backgroundColor?: string;
  paddingPx?: number;
}

export interface QrStyle {
  foreground: string; // brand color, hex
  background: string; // hex
  dotStyle?: DotStyle;
  eyeStyle?: EyeStyle;
  /** Quiet-zone width in modules. Must be >= 4 (spec). */
  quietZoneModules?: number;
  frame?: QrFrame;
  /** Center logo as a data URI (png/svg). Max 28% of code width. */
  logoDataUri?: string;
  /** Logo width as % of code width (default 20). */
  logoSizePct?: number;
  /** Pixels per module for PNG export (default 12 → ~400px for v2+QZ). */
  modulePx?: number;
}

export interface ScannabilityCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface ScannabilityVerdict {
  passed: boolean;
  checks: ScannabilityCheck[];
}

export interface QrRenderResult {
  svg: string;
  /** High-res PNG buffer. */
  png: Buffer;
  /** Edge length in modules including quiet zone. */
  modulesWithQuietZone: number;
  validation: ScannabilityVerdict;
}

const FINDER = 7;

function inFinderZone(size: number, r: number, c: number): boolean {
  const in7 = (v: number) => v < FINDER || v >= size - FINDER;
  return in7(r) && in7(c);
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function luminance(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return NaN;
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(rgb.r) + 0.7152 * lin(rgb.g) + 0.0722 * lin(rgb.b);
}

/** WCAG contrast ratio. Scanners need strong contrast; 3.0 is the floor. */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  if (Number.isNaN(la) || Number.isNaN(lb)) return NaN;
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

export function validateScannability(matrix: QrMatrix, style: QrStyle): ScannabilityVerdict {
  const checks: ScannabilityCheck[] = [];
  const qz = style.quietZoneModules ?? 4;

  // 1. Contrast guardrail.
  const ratio = contrastRatio(style.foreground, style.background);
  const contrastPass = !Number.isNaN(ratio) && ratio >= 3.0;
  checks.push({
    name: "contrast",
    passed: contrastPass,
    detail: Number.isNaN(ratio)
      ? "foreground/background are not parseable hex colors"
      : `contrast ratio ${ratio.toFixed(2)}:1 (floor 3.0, recommended ≥ 4.5)`,
  });

  // 2. Quiet zone.
  checks.push({
    name: "quiet_zone",
    passed: Number.isFinite(qz) && qz >= 4,
    detail: `quiet zone ${qz} modules (minimum 4 per ISO/IEC 18004)`,
  });

  // 3. Finder integrity: finders are always rendered from the real matrix
  // (topology preserved by construction); the failure mode is a logo
  // covering them.
  const logoPct = style.logoSizePct ?? 20;
  const logoHalfModules = (logoPct / 100) * matrix.size * 0.62; // incl. backdrop
  const finderClear = logoHalfModules < matrix.size / 2 - FINDER;
  const logoOk = !style.logoDataUri || (logoPct <= 28 && finderClear);
  checks.push({
    name: "finder_integrity",
    passed: logoOk,
    detail: style.logoDataUri
      ? `logo ${logoPct}% of code width — ${logoPct <= 28 && finderClear ? "clear of finder patterns" : "TOO LARGE: would cover finders"}`
      : "no logo; finder patterns rendered from the real matrix",
  });

  // 4. Error correction: logo-bearing codes REQUIRE H.
  const ecOk = !style.logoDataUri || matrix.errorCorrection === "H";
  checks.push({
    name: "error_correction",
    passed: ecOk,
    detail: style.logoDataUri
      ? `error correction ${matrix.errorCorrection} (H required when a logo is embedded)`
      : `error correction ${matrix.errorCorrection}`,
  });

  return { passed: checks.every((c) => c.passed), checks };
}

// ---------------------------------------------------------------------------
// SVG rendering
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

function renderSvg(matrix: QrMatrix, style: QrStyle): string {
  const { size } = matrix;
  const qz = style.quietZoneModules ?? 4;
  const dot = style.dotStyle ?? "square";
  const eye = style.eyeStyle ?? "square";
  const fg = style.foreground;
  const bg = style.background;
  const total = size + qz * 2;

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" role="img">`,
    `<rect width="${total}" height="${total}" fill="${esc(bg)}"/>`,
  );

  const ox = qz;
  const oy = qz;

  // Body modules (skip finder zones — drawn separately with eye style).
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!matrix.dark(r, c) || inFinderZone(size, r, c)) continue;
      const x = ox + c;
      const y = oy + r;
      if (dot === "square") {
        parts.push(`<rect x="${x}" y="${y}" width="1" height="1" fill="${esc(fg)}"/>`);
      } else if (dot === "rounded") {
        parts.push(
          `<rect x="${x + 0.06}" y="${y + 0.06}" width="0.88" height="0.88" rx="0.32" fill="${esc(fg)}"/>`,
        );
      } else {
        parts.push(
          `<circle cx="${x + 0.5}" cy="${y + 0.5}" r="0.46" fill="${esc(fg)}"/>`,
        );
      }
    }
  }

  // Finder patterns: topology preserved (7x7 ring + 3x3 core), styled shell.
  const finderOrigins: [number, number][] = [
    [0, 0],
    [0, size - FINDER],
    [size - FINDER, 0],
  ];
  for (const [fr, fc] of finderOrigins) {
    const x = ox + fc;
    const y = oy + fr;
    if (eye === "circle") {
      parts.push(
        `<circle cx="${x + 3.5}" cy="${y + 3.5}" r="3.5" fill="${esc(fg)}"/>`,
        `<circle cx="${x + 3.5}" cy="${y + 3.5}" r="2.5" fill="${esc(bg)}"/>`,
        `<circle cx="${x + 3.5}" cy="${y + 3.5}" r="1.5" fill="${esc(fg)}"/>`,
      );
    } else if (eye === "rounded") {
      parts.push(
        `<rect x="${x}" y="${y}" width="7" height="7" rx="2" fill="${esc(fg)}"/>`,
        `<rect x="${x + 1}" y="${y + 1}" width="5" height="5" rx="1.4" fill="${esc(bg)}"/>`,
        `<rect x="${x + 2}" y="${y + 2}" width="3" height="3" rx="0.9" fill="${esc(fg)}"/>`,
      );
    } else {
      parts.push(
        `<rect x="${x}" y="${y}" width="7" height="7" fill="${esc(fg)}"/>`,
        `<rect x="${x + 1}" y="${y + 1}" width="5" height="5" fill="${esc(bg)}"/>`,
        `<rect x="${x + 2}" y="${y + 2}" width="3" height="3" fill="${esc(fg)}"/>`,
      );
    }
  }

  // Center logo (SVG <image>; the white rounded backdrop keeps contrast).
  if (style.logoDataUri) {
    const pct = Math.min(style.logoSizePct ?? 20, 28) / 100;
    const lw = size * pct;
    const lx = ox + (size - lw) / 2;
    const ly = oy + (size - lw) / 2;
    const pad = lw * 0.12;
    parts.push(
      `<rect x="${(lx - pad).toFixed(2)}" y="${(ly - pad).toFixed(2)}" width="${(lw + pad * 2).toFixed(2)}" height="${(lw + pad * 2).toFixed(2)}" rx="${(pad * 1.5).toFixed(2)}" fill="${esc(bg)}"/>`,
      `<image href="${esc(style.logoDataUri)}" x="${lx.toFixed(2)}" y="${ly.toFixed(2)}" width="${lw.toFixed(2)}" height="${lw.toFixed(2)}" preserveAspectRatio="xMidYMid meet"/>`,
    );
  }

  // Printable frame with CTA text.
  if (style.frame) {
    const f = style.frame;
    const fh = 3.2; // frame height in modules
    const pad = f.paddingPx ?? 1;
    const frameTop = total;
    const frameH = fh + pad;
    parts.push(
      `<rect x="0" y="${frameTop}" width="${total}" height="${frameH}" fill="${esc(f.backgroundColor ?? bg)}"/>`,
      `<text x="${total / 2}" y="${(frameTop + frameH / 2 + 0.55).toFixed(2)}" text-anchor="middle" font-family="system-ui, sans-serif" font-size="1.7" font-weight="700" fill="${esc(f.textColor ?? fg)}">${esc(f.text)}</text>`,
    );
    // Expand the viewBox to include the frame.
    parts[0] = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${(total + frameH).toFixed(2)}" role="img">`;
  }

  parts.push("</svg>");
  return parts.join("");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * ARTWORK-LAYER PRIMITIVE for lib/studio/qr-designer.ts.
 * Tiles `style` onto the real `matrix` (data untouched), validates
 * scannability, and returns SVG + high-res PNG. Throws on validation
 * failure when strict (default) — styled codes that fail stay out of the
 * approval object.
 */
export async function renderQr(
  matrix: QrMatrix,
  style: QrStyle,
  opts: { strict?: boolean } = {},
): Promise<QrRenderResult> {
  const strict = opts.strict ?? true;
  const validation = validateScannability(matrix, style);
  if (strict && !validation.passed) {
    const reasons = validation.checks
      .filter((c) => !c.passed)
      .map((c) => `${c.name}: ${c.detail}`)
      .join("; ");
    throw new Error(`QR scannability validation failed — ${reasons}`);
  }
  const svg = renderSvg(matrix, style);
  const modulePx = style.modulePx ?? 12;
  const qz = style.quietZoneModules ?? 4;
  const px = (matrix.size + qz * 2) * modulePx;
  const png = await sharp(Buffer.from(svg), { density: 300 })
    .resize(px, Math.round((px * (matrix.size + qz * 2 + (style.frame ? 4.2 : 0))) / (matrix.size + qz * 2)))
    .png()
    .toBuffer();
  return {
    svg,
    png,
    modulesWithQuietZone: matrix.size + qz * 2,
    validation,
  };
}

/** Convenience: encode + render in one call. Forces EC=H when a logo is set. */
export async function renderCustomizedQr(
  data: string,
  style: QrStyle,
  opts: { strict?: boolean } = {},
): Promise<QrRenderResult> {
  const matrix = encodeQr(data, {
    errorCorrection: style.logoDataUri ? "H" : "M",
  });
  return renderQr(matrix, style, opts);
}

/** Suggested minimum print width (cm) ≈ 10% of the read distance. */
export function suggestedPrintWidthCm(readDistanceCm: number): number {
  return Math.max(2, readDistanceCm * 0.1);
}
