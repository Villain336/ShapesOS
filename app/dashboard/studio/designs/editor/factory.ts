// Marketr — Phase 11 "Canvas": element factory helpers for the editor panels.
// Builds well-formed DesignElements (per lib/design/types.ts) centered on a page.

import { newId } from "@/lib/design/types";
import type {
  ChartElement,
  DesignElement,
  EllipseElement,
  ImageElement,
  LineElement,
  QrElement,
  RectElement,
  SvgElement,
  TextElement,
} from "@/lib/design/types";

function base(name: string, x: number, y: number) {
  return {
    id: newId("el"),
    name,
    x,
    y,
    rotation: 0,
    opacity: 1,
    visible: true,
    locked: false,
  };
}

export function makeText(opts: {
  text: string;
  fontSize: number;
  fontStyle?: TextElement["fontStyle"];
  fill?: string;
  align?: TextElement["align"];
  width?: number;
  pageW: number;
  pageH: number;
  name?: string;
}): TextElement {
  const w = opts.width ?? Math.min(opts.pageW * 0.8, 900);
  return {
    ...base(opts.name ?? "Text", opts.pageW / 2 - w / 2, opts.pageH / 2 - opts.fontSize / 2),
    type: "text",
    text: opts.text,
    fontFamily: "Inter",
    fontSize: opts.fontSize,
    fontStyle: opts.fontStyle ?? "normal",
    fill: opts.fill ?? "#1c1917",
    align: opts.align ?? "center",
    lineHeight: 1.25,
    letterSpacing: 0,
    width: w,
  };
}

export function makeRect(opts: {
  width: number;
  height: number;
  fill: string;
  cornerRadius?: number;
  pageW: number;
  pageH: number;
  name?: string;
}): RectElement {
  return {
    ...base(opts.name ?? "Rectangle", opts.pageW / 2 - opts.width / 2, opts.pageH / 2 - opts.height / 2),
    type: "rect",
    width: opts.width,
    height: opts.height,
    fill: opts.fill,
    cornerRadius: opts.cornerRadius ?? 0,
  };
}

export function makeEllipse(opts: {
  radiusX: number;
  radiusY: number;
  fill: string;
  pageW: number;
  pageH: number;
  name?: string;
}): EllipseElement {
  return {
    ...base(opts.name ?? "Ellipse", opts.pageW / 2, opts.pageH / 2),
    type: "ellipse",
    radiusX: opts.radiusX,
    radiusY: opts.radiusY,
    fill: opts.fill,
  };
}

export function makeLine(opts: {
  length?: number;
  stroke?: string;
  strokeWidth?: number;
  pageW: number;
  pageH: number;
  name?: string;
}): LineElement {
  const length = opts.length ?? 320;
  return {
    ...base(opts.name ?? "Line", opts.pageW / 2 - length / 2, opts.pageH / 2),
    type: "line",
    points: [0, 0, length, 0],
    stroke: opts.stroke ?? "#1c1917",
    strokeWidth: opts.strokeWidth ?? 3,
  };
}

export function makeSvg(opts: {
  path: string;
  fill?: string;
  size?: number;
  pageW: number;
  pageH: number;
  name?: string;
}): SvgElement {
  const size = opts.size ?? 96;
  return {
    ...base(opts.name ?? "Icon", opts.pageW / 2 - size / 2, opts.pageH / 2 - size / 2),
    type: "svg",
    path: opts.path,
    width: size,
    height: size,
    fill: opts.fill ?? "#7c3aed",
  };
}

export function makeImage(opts: {
  src: string;
  width: number;
  height: number;
  pageW: number;
  pageH: number;
  name?: string;
}): ImageElement {
  return {
    ...base(opts.name ?? "Image", opts.pageW / 2 - opts.width / 2, opts.pageH / 2 - opts.height / 2),
    type: "image",
    src: opts.src,
    width: opts.width,
    height: opts.height,
    cornerRadius: 0,
  };
}

/** Fit dimensions inside a max box, preserving aspect ratio. */
export function fitBox(w: number, h: number, max: number): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(w, h));
  return { width: Math.round(w * scale), height: Math.round(h * scale) };
}

const CHART_SEED_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun"];
const CHART_SEED_VALUES = [42, 68, 35, 81, 57, 74];
const CHART_W = 480;
const CHART_H = 300;

/** House palette shared by chart factories and the Elements panel swatches. */
export const DEFAULT_FACTORY_COLORS = [
  "#7c3aed",
  "#8b5cf6",
  "#0ea5e9",
  "#10b981",
  "#f59e0b",
];

/** A chart with starter data so the user sees a real chart immediately. */
export function makeChart(opts: {
  chartType: ChartElement["chartType"];
  pageW: number;
  pageH: number;
  name?: string;
}): ChartElement {
  return {
    ...base(
      opts.name ?? "Chart",
      opts.pageW / 2 - CHART_W / 2,
      opts.pageH / 2 - CHART_H / 2,
    ),
    type: "chart",
    chartType: opts.chartType,
    labels: [...CHART_SEED_LABELS],
    values: [...CHART_SEED_VALUES],
    colors: [...DEFAULT_FACTORY_COLORS],
    showValues: true,
  };
}

/** A QR code with a starter payload. */
export function makeQr(opts: {
  payload?: string;
  size?: number;
  pageW: number;
  pageH: number;
  name?: string;
}): QrElement {
  const size = opts.size ?? 160;
  return {
    ...base(opts.name ?? "QR code", opts.pageW / 2 - size / 2, opts.pageH / 2 - size / 2),
    type: "qr",
    payload: opts.payload ?? "https://marketr.app",
    size,
    foreground: "#1c1917",
    background: "#ffffff",
  };
}

export type { DesignElement };
