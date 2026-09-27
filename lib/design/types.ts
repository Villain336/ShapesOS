// Marketr — Phase 11 "Canvas" design document schema.
// The design JSON is the strategic asset: it is simultaneously the save
// format, the template format, the export input, and (later) the LLM
// structured-output target. Element types are a typed core; `custom` is the
// schemaless escape hatch for host-app metadata (campaign ids, asset ids…).

export const DESIGN_SCHEMA_VERSION = 1;

export type ElementType =
  | "text"
  | "image"
  | "rect"
  | "ellipse"
  | "line"
  | "svg"
  | "chart"
  | "qr";

export interface BaseElement {
  id: string;
  type: ElementType;
  name: string;
  x: number;
  y: number;
  rotation: number; // degrees
  opacity: number; // 0..1
  visible: boolean;
  locked: boolean;
  /** Schemaless host-app metadata — never interpreted by the renderer. */
  custom?: Record<string, unknown>;
}

export interface TextElement extends BaseElement {
  type: "text";
  text: string;
  fontFamily: string;
  fontSize: number;
  fontStyle: "normal" | "bold" | "italic" | "bold-italic";
  fill: string;
  align: "left" | "center" | "right";
  lineHeight: number;
  letterSpacing: number;
  width?: number; // wrap width; undefined = no wrap
  /**
   * Per-fragment styling (richer text). When present and non-empty, the
   * renderer styles each fragment individually; `text` remains the
   * plain-text concatenation (used for export fallbacks, search, and
   * {{variable}} substitution). Fragment fields fall back to the element's
   * own fontFamily/fontSize/fontStyle/fill when omitted.
   */
  fragments?: TextFragment[];
  /**
   * Text-on-a-path: SVG path data string. When set, text follows the path
   * (Konva TextPath). Fragments are ignored in path mode.
   */
  textPath?: string;
}

/** One styled run inside a TextElement. All style fields optional. */
export interface TextFragment {
  text: string;
  fontFamily?: string;
  fontSize?: number;
  fontStyle?: "normal" | "bold" | "italic" | "bold-italic";
  fill?: string;
}

export interface ImageElement extends BaseElement {
  type: "image";
  src: string; // URL or data URL
  width: number;
  height: number;
  cornerRadius: number;
}

export interface RectElement extends BaseElement {
  type: "rect";
  width: number;
  height: number;
  fill: string;
  /** Linear gradient: [from, to] — takes precedence over fill when set. */
  gradient?: [string, string];
  cornerRadius: number;
  stroke?: string;
  strokeWidth?: number;
}

export interface EllipseElement extends BaseElement {
  type: "ellipse";
  radiusX: number;
  radiusY: number;
  fill: string;
  gradient?: [string, string];
  stroke?: string;
  strokeWidth?: number;
}

export interface LineElement extends BaseElement {
  type: "line";
  points: number[]; // [x1,y1,x2,y2,...] relative to x/y
  stroke: string;
  strokeWidth: number;
  dash?: number[];
}

export interface SvgElement extends BaseElement {
  type: "svg";
  /** Raw SVG path data (24x24 viewBox icon convention). */
  path: string;
  width: number;
  height: number;
  fill: string;
}

export interface ChartElement extends BaseElement {
  type: "chart";
  chartType: "bar" | "line" | "pie";
  /** Series data: labels[i] pairs with values[i]. */
  labels: string[];
  values: number[];
  /** Brand palette; cycles when shorter than the data. */
  colors: string[];
  /** Show value labels on the chart. */
  showValues: boolean;
}

export interface QrElement extends BaseElement {
  type: "qr";
  /** Encoded payload (URL or text). */
  payload: string;
  /** Rendered square size. */
  size: number;
  foreground: string;
  background: string;
}

export type DesignElement =
  | TextElement
  | ImageElement
  | RectElement
  | EllipseElement
  | LineElement
  | SvgElement
  | ChartElement
  | QrElement;

export interface DesignPage {
  id: string;
  name: string;
  width: number;
  height: number;
  /** Page background fill. */
  background: string;
  elements: DesignElement[];
}

export interface DesignDocument {
  schemaVersion: number;
  pages: DesignPage[];
}

// ── Templates ──────────────────────────────────────────────────────────────

export interface DesignTemplate {
  key: string;
  name: string;
  category: "social" | "ads" | "web" | "print";
  width: number;
  height: number;
  description: string;
  /** Builds a starter document (placeholder content in Marketr's voice). */
  build: () => DesignDocument;
}

export function blankDocument(width: number, height: number, background = "#ffffff"): DesignDocument {
  return {
    schemaVersion: DESIGN_SCHEMA_VERSION,
    pages: [
      {
        id: `page-${Math.random().toString(36).slice(2, 9)}`,
        name: "Page 1",
        width,
        height,
        background,
        elements: [],
      },
    ],
  };
}

let idCounter = 0;
export function newId(prefix = "el"): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
