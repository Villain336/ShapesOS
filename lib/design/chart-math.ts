// Marketr — Phase 11 "Canvas": pure chart geometry helpers.
// Framework-free (no DOM, no Konva) so the math is unit-testable in node.
// ChartNode.tsx consumes these; tests live in lib/design/__tests__/chart-qr.test.ts.

export const CHART_DEFAULT_WIDTH = 480;
export const CHART_DEFAULT_HEIGHT = 300;

/** Tasteful default palette — violet-led, matches the Marketr house style. */
export const DEFAULT_CHART_COLORS = [
  "#7c3aed", // violet-600
  "#8b5cf6", // violet-500
  "#0ea5e9", // sky-500
  "#10b981", // emerald-500
  "#f59e0b", // amber-500
  "#f43f5e", // rose-500
  "#6366f1", // indigo-500
  "#14b8a6", // teal-500
];

/** Cycle the palette when there are more series points than colors. */
export function colorFor(index: number, colors: string[]): string {
  const palette = colors.length > 0 ? colors : DEFAULT_CHART_COLORS;
  return palette[((index % palette.length) + palette.length) % palette.length]!;
}

/** Round a data maximum up to a "nice" axis ceiling (1 / 2 / 2.5 / 5 × 10ⁿ). */
export function niceCeil(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 1;
  const exp = Math.floor(Math.log10(v));
  const base = 10 ** exp;
  const n = v / base;
  const nice = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return nice * base;
}

/** Compact axis/value formatting: 1500 → "1.5k", integers stay plain. */
export function formatChartValue(v: number): string {
  if (!Number.isFinite(v)) return "–";
  const abs = Math.abs(v);
  if (abs >= 1000) {
    const k = v / 1000;
    return `${Number.isInteger(k) ? k : k.toFixed(1)}k`;
  }
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

export function truncateLabel(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Append an alpha channel to a #rrggbb hex color (for area fills). */
export function withAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1]!, 16);
  const a = Math.min(1, Math.max(0, alpha));
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// ── Cartesian (bar / line) ───────────────────────────────────────────────

export interface PlotArea {
  x: number;
  y: number;
  w: number;
  h: number;
}

const PAD_LEFT = 48; // room for y-axis tick labels
const PAD_RIGHT = 18;
const PAD_TOP = 30; // room for value labels above bars/dots
const PAD_BOTTOM = 36; // room for category labels

export function plotArea(w: number, h: number): PlotArea {
  return {
    x: PAD_LEFT,
    y: PAD_TOP,
    w: Math.max(40, w - PAD_LEFT - PAD_RIGHT),
    h: Math.max(40, h - PAD_TOP - PAD_BOTTOM),
  };
}

export interface YTick {
  value: number;
  y: number;
}

export interface CartesianScale {
  plot: PlotArea;
  yOf: (v: number) => number;
  ticks: YTick[];
  baselineY: number;
}

/** Shared y-scale for bar & line: baseline at 0, handles negatives. */
export function cartesianScale(values: number[], w: number, h: number): CartesianScale {
  const plot = plotArea(w, h);
  const lo = Math.min(0, ...values);
  let hi = Math.max(0, ...values);
  hi = niceCeil(hi <= lo ? lo + 1 : hi);
  const span = hi - lo || 1;
  const yOf = (v: number) => plot.y + plot.h * (1 - (v - lo) / span);
  const baselineY = yOf(0);
  const ticks: YTick[] = [];
  const count = 5;
  for (let i = 0; i < count; i++) {
    const value = lo + (span * i) / (count - 1);
    ticks.push({ value, y: yOf(value) });
  }
  return { plot, yOf, ticks, baselineY };
}

export interface BarGeom {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Center x of the bar (for labels). */
  cx: number;
  /** y just above the bar (for the value label). */
  labelY: number;
  value: number;
  label: string;
  color: string;
}

export interface BarModel extends CartesianScale {
  bars: BarGeom[];
  /** Skip every Nth category label when crowded. */
  labelStep: number;
}

export function barModel(
  labels: string[],
  values: number[],
  colors: string[],
  w: number,
  h: number,
): BarModel {
  const scale = cartesianScale(values, w, h);
  const { plot, yOf, baselineY } = scale;
  const n = values.length;
  const slotW = n > 0 ? plot.w / n : plot.w;
  const barW = Math.min(slotW * 0.62, 72);
  const bars: BarGeom[] = values.map((value, i) => {
    const cx = plot.x + slotW * i + slotW / 2;
    const yv = yOf(value);
    const top = Math.min(yv, baselineY);
    const bh = Math.max(2, Math.abs(yv - baselineY));
    return {
      x: cx - barW / 2,
      y: top,
      w: barW,
      h: bh,
      cx,
      labelY: value >= 0 ? top - 6 : top + bh + 16,
      value,
      label: labels[i] ?? "",
      color: colorFor(i, colors),
    };
  });
  return { ...scale, bars, labelStep: n > 12 ? 2 : 1 };
}

export interface LineModel extends CartesianScale {
  /** Polyline points [x1,y1,x2,y2,…] for the Konva Line. */
  points: number[];
  /** Closed points for the area fill under the line. */
  areaPoints: number[];
  dots: { x: number; y: number; value: number; color: string }[];
  /** Category label anchors under each dot. */
  categories: { x: number; label: string }[];
  color: string;
}

export function lineModel(
  labels: string[],
  values: number[],
  colors: string[],
  w: number,
  h: number,
): LineModel {
  const scale = cartesianScale(values, w, h);
  const { plot, yOf, baselineY } = scale;
  const n = values.length;
  const color = colorFor(0, colors);
  const dots = values.map((value, i) => ({
    x: n === 1 ? plot.x + plot.w / 2 : plot.x + (plot.w * i) / (n - 1),
    y: yOf(value),
    value,
    color: colorFor(i, colors),
  }));
  const points = dots.flatMap((d) => [d.x, d.y]);
  const areaPoints =
    dots.length > 0
      ? [...points, dots[dots.length - 1]!.x, baselineY, dots[0]!.x, baselineY]
      : [];
  const categories = dots.map((d, i) => ({ x: d.x, label: labels[i] ?? "" }));
  return { ...scale, points, areaPoints, dots, categories, color };
}

// ── Pie ──────────────────────────────────────────────────────────────────

export interface PieSlice {
  /** Start angle in degrees (Konva convention: 0° = 3 o'clock, clockwise). */
  startDeg: number;
  sweepDeg: number;
  fraction: number;
  value: number;
  label: string;
  color: string;
}

/** Slices start at 12 o'clock and run clockwise; fractions always sum to 1. */
export function pieSlices(
  labels: string[],
  values: number[],
  colors: string[],
): PieSlice[] {
  const safe = values.map((v) => Math.max(0, v));
  const total = safe.reduce((a, b) => a + b, 0);
  const fractions =
    total > 0 ? safe.map((v) => v / total) : safe.map(() => 1 / Math.max(1, safe.length));
  let acc = -90;
  return fractions.map((fraction, i) => {
    const startDeg = acc;
    acc += fraction * 360;
    return {
      startDeg,
      sweepDeg: fraction * 360,
      fraction,
      value: values[i] ?? 0,
      label: labels[i] ?? "",
      color: colorFor(i, colors),
    };
  });
}

export interface PieLayout {
  cx: number;
  cy: number;
  r: number;
  legendX: number;
  legendW: number;
  rowH: number;
}

export function pieLayout(w: number, h: number, rows: number): PieLayout {
  const r = Math.min(120, h / 2 - 28, w * 0.28);
  const cx = Math.min(170, w * 0.34);
  const cy = h / 2;
  const legendX = cx + r + 36;
  const legendW = Math.max(60, w - legendX - 24);
  const rowH = Math.min(28, Math.max(18, (h - 64) / Math.max(1, rows)));
  return { cx, cy, r, legendX, legendW, rowH };
}

// ── Resizable storage (in element.custom — schema stays untouched) ────────

export function chartSize(el: { custom?: Record<string, unknown> }): {
  w: number;
  h: number;
} {
  const c = el.custom ?? {};
  const w = typeof c.w === "number" && c.w > 0 ? c.w : CHART_DEFAULT_WIDTH;
  const h = typeof c.h === "number" && c.h > 0 ? c.h : CHART_DEFAULT_HEIGHT;
  return { w, h };
}
