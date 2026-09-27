// Marketr — Phase 11 "Canvas": 20 built-in SVG mockup frames.
//
// Integration #9 of the Phase 11 asset/API survey (§9 "Mediamodifier" row):
// "ship 20 built-in SVG device frames first — 80% of Mediamodifier's value
// at $0; Mediamodifier API stays phase 2". No Mediamodifier code here.
//
// ARTWORK: all 20 frames are ORIGINAL geometric artwork authored in this
// file (no tracing of Apple/product renders, no mockup-vendor artwork).
// House style: clean, light, violet/stone accents on stone-900 device
// bodies. Each frame is drawn in a 24-unit-wide art space
// (viewBox `0 0 24 <artH>`) so it maps 1:1 onto the editor's `svg` element
// convention (renderer scales path space by width/24).
//
// SCREEN-RECT INTERACTION DESIGN (the pragmatic version):
//  - Inserting a frame adds a small linked set of elements, all tagged in
//    `custom.mockup = { frameId, role }`:
//      1. the frame body (`svg` element, single fill),
//      2. an optional detail layer (`svg` element, contrasting fill —
//         camera dots, keys, handles, stands…),
//      3. the SCREEN (`image` element) placed ON TOP of the body at the
//         declared screen rect, with a light "YOUR DESIGN" placeholder.
//  - The screen is a real selectable element: the user clicks the screen
//    area and the Mockups panel section offers "Set screen image…"
//    (file picker → data URL replaces the placeholder src) plus Reset.
//    No double-click handler — that would need a DesignCanvas change,
//    deliberately out of scope for this integration.
//  - The screen image stretches to fill the screen rect (Konva Image and
//    the SVG exporter both use stretch semantics), so matching the
//    screen's aspect ratio avoids distortion.
//  - The set is NOT a single group element (the schema has no group
//    type): the pieces move/scale together via multi-select. Inserting
//    is one element per addElement call, so undo removes them one at a
//    time — documented, acceptable for v1.
//  - Export: frames are plain `svg` + `image` elements, so the existing
//    SVG exporter and PNG/JPG raster export handle them with no changes.

import { newId, type DesignElement, type ImageElement } from "./types";

// ── Palette (locked Marketr accents) ───────────────────────────────────────

const INK = "#1c1917"; // stone-900 — device bodies
const DETAIL_DARK = "#57534e"; // stone-600 — details on dark bodies
const DETAIL_MID = "#78716c"; // stone-500 — details / app icons
const DETAIL_LIGHT = "#a8a29e"; // stone-400 — light details
const PAPER_DARK = "#d6d3d1"; // stone-300 — light card bodies
const PAPER = "#e7e5e4"; // stone-200 — light details on dark bodies
const PAPER_LIGHT = "#f5f4f2"; // stone-100 — pages
const VIOLET = "#7c3aed"; // brand accent

// ── Tiny path DSL (24-wide art space) ─────────────────────────────────────

const f2 = (v: number): string => {
  const r = Math.round(v * 100) / 100;
  return Object.is(r, -0) ? "0" : String(r);
};

/** Rounded rect, clockwise. */
function rr(x: number, y: number, w: number, h: number, r: number): string {
  const rad = Math.min(r, w / 2, h / 2);
  return [
    `M${f2(x + rad)},${f2(y)}`,
    `H${f2(x + w - rad)}`,
    `Q${f2(x + w)},${f2(y)} ${f2(x + w)},${f2(y + rad)}`,
    `V${f2(y + h - rad)}`,
    `Q${f2(x + w)},${f2(y + h)} ${f2(x + w - rad)},${f2(y + h)}`,
    `H${f2(x + rad)}`,
    `Q${f2(x)},${f2(y + h)} ${f2(x)},${f2(y + h - rad)}`,
    `V${f2(y + rad)}`,
    `Q${f2(x)},${f2(y)} ${f2(x + rad)},${f2(y)}`,
    "Z",
  ].join(" ");
}

/** Circle via two arcs. */
function circ(cx: number, cy: number, r: number): string {
  return (
    `M${f2(cx - r)},${f2(cy)} ` +
    `A${f2(r)},${f2(r)} 0 1,0 ${f2(cx + r)},${f2(cy)} ` +
    `A${f2(r)},${f2(r)} 0 1,0 ${f2(cx - r)},${f2(cy)} Z`
  );
}

/** Ellipse via two arcs. */
function ell(cx: number, cy: number, rx: number, ry: number): string {
  return (
    `M${f2(cx - rx)},${f2(cy)} ` +
    `A${f2(rx)},${f2(ry)} 0 1,0 ${f2(cx + rx)},${f2(cy)} ` +
    `A${f2(rx)},${f2(ry)} 0 1,0 ${f2(cx - rx)},${f2(cy)} Z`
  );
}

/** Closed polygon. */
function poly(pts: Array<readonly [number, number]>): string {
  return "M" + pts.map(([x, y]) => `${f2(x)},${f2(y)}`).join(" L") + " Z";
}

/** Join subpaths into one fill. */
const P = (...parts: string[]): string => parts.join(" ");

/** Grid of rounded-rect keys (laptop keyboards). */
function keyGrid(x0: number, y0: number, cols: number, rows: number): string {
  const kw = 1.35;
  const kh = 0.5;
  const sx = 1.63;
  const sy = 0.65;
  const out: string[] = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      out.push(rr(x0 + c * sx, y0 + r * sy, kw, kh, 0.12));
  return P(...out);
}

/** 3×3 app-icon grid, skipping the center cell (the screen slot). */
function appIconGrid(): string {
  const out: string[] = [];
  for (let j = 0; j < 3; j++)
    for (let i = 0; i < 3; i++) {
      if (i === 1 && j === 1) continue;
      out.push(rr(3.4 + i * 6.8, 3.4 + j * 6.8, 5.6, 5.6, 1.4));
    }
  return P(...out);
}

// ── Frame definitions ─────────────────────────────────────────────────────

export type MockupCategory =
  | "device"
  | "web"
  | "social"
  | "print"
  | "promo"
  | "wearable";

export interface ScreenRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface MockupFrameDef {
  /** URL-safe id, e.g. "phone-front". */
  id: string;
  /** Human name shown in the panel. */
  name: string;
  category: MockupCategory;
  /**
   * Art-space height. Width is always 24 (matches the editor's svg-element
   * convention: path data lives in 24-wide space, scaled by width/24).
   */
  artH: number;
  /** Screen rect in art space — where the user's design goes. */
  screen: ScreenRect;
  /** Frame body path (single fill). */
  body: string;
  bodyFill: string;
  /** Optional detail path (contrasting fill), drawn over the body. */
  detail?: string;
  detailFill?: string;
  /** Default on-canvas width in px (height follows artH aspect). */
  defaultW: number;
}

export const MOCKUP_FRAMES: MockupFrameDef[] = [
  {
    id: "phone-front",
    name: "Phone · front",
    category: "device",
    artH: 48,
    screen: { x: 4, y: 9, w: 16, h: 30 },
    body: rr(2, 1, 20, 46, 4),
    bodyFill: INK,
    detail: P(
      rr(9, 2.6, 6, 2.2, 1.1), // notch
      rr(1.2, 10, 0.8, 3, 0.4), // side buttons
      rr(1.2, 14, 0.8, 3, 0.4),
      rr(10, 43.5, 4, 0.8, 0.4), // home indicator
    ),
    detailFill: PAPER,
    defaultW: 280,
  },
  {
    id: "phone-angled",
    name: "Phone · angled",
    category: "device",
    artH: 48,
    screen: { x: 4, y: 10, w: 14.5, h: 30 },
    // Back copy offset up-right = visible thickness (flat "3D" trick).
    body: P(rr(3.5, 1, 18.5, 44, 3.6), rr(2, 3, 18.5, 44, 3.6)),
    bodyFill: INK,
    detail: P(
      rr(4.5, 4.8, 4, 3.6, 1), // camera module
      circ(16.8, 6.2, 0.55), // flash
      rr(9.5, 42.8, 4, 0.8, 0.4), // home indicator
    ),
    detailFill: DETAIL_DARK,
    defaultW: 280,
  },
  {
    id: "tablet",
    name: "Tablet",
    category: "device",
    artH: 32,
    screen: { x: 3.8, y: 5, w: 16.4, h: 22 },
    body: rr(2, 1, 20, 30, 2.5),
    bodyFill: INK,
    detail: circ(12, 3, 0.7),
    detailFill: PAPER,
    defaultW: 320,
  },
  {
    id: "laptop-front",
    name: "Laptop · front",
    category: "device",
    artH: 15,
    screen: { x: 4.4, y: 2.4, w: 15.2, h: 6.7 },
    body: P(
      rr(3, 1, 18, 9.5, 1), // screen bezel
      poly([
        [2.5, 11.6],
        [21.5, 11.6],
        [23.2, 14.6],
        [0.8, 14.6],
      ]), // keyboard deck
    ),
    bodyFill: INK,
    detail: P(circ(12, 1.9, 0.45), keyGrid(6.2, 12.3, 8, 3)),
    detailFill: DETAIL_DARK,
    defaultW: 420,
  },
  {
    id: "laptop-angled",
    name: "Laptop · angled",
    category: "device",
    artH: 16,
    screen: { x: 4.4, y: 3.4, w: 14.2, h: 6.7 },
    body: P(
      rr(4.5, 0.8, 17, 9.5, 1), // back lid (thickness)
      rr(3, 2, 17, 9.5, 1), // front bezel
      poly([
        [1.5, 11.4],
        [22, 11.4],
        [23.5, 15.2],
        [0.5, 15.2],
      ]), // deck in perspective
    ),
    bodyFill: INK,
    detail: P(circ(11.5, 2.9, 0.4), keyGrid(6.0, 12.1, 8, 3)),
    detailFill: DETAIL_DARK,
    defaultW: 420,
  },
  {
    id: "desktop-monitor",
    name: "Desktop monitor",
    category: "device",
    artH: 20,
    screen: { x: 4.4, y: 2.4, w: 15.2, h: 8.7 },
    body: P(
      rr(3, 1, 18, 11.5, 1), // bezel
      rr(11, 12.5, 2, 2.8, 0.4), // neck
      rr(7, 15.5, 10, 1.8, 0.9), // base
    ),
    bodyFill: INK,
    detail: circ(12, 11.8, 0.35), // power LED
    detailFill: VIOLET,
    defaultW: 440,
  },
  {
    id: "browser-window",
    name: "Browser window",
    category: "web",
    artH: 15,
    screen: { x: 2.2, y: 5.2, w: 19.6, h: 7.6 },
    body: rr(1, 1, 22, 13, 1.5),
    bodyFill: INK,
    detail: P(
      circ(3, 3, 0.7), // traffic lights
      circ(4.8, 3, 0.7),
      circ(6.6, 3, 0.7),
      rr(8.6, 2.2, 10, 1.7, 0.85), // URL bar
    ),
    detailFill: PAPER,
    defaultW: 460,
  },
  {
    id: "social-post",
    name: "Social post",
    category: "social",
    artH: 26,
    screen: { x: 3.4, y: 7.5, w: 17.2, h: 10 },
    body: rr(2, 1, 20, 24, 2),
    bodyFill: PAPER_DARK,
    detail: P(
      circ(5.2, 4.2, 1.6), // avatar
      rr(7.6, 3.1, 6, 1.1, 0.55), // name bars
      rr(7.6, 4.9, 4, 0.9, 0.45),
      rr(3.4, 19, 4, 1, 0.5), // action row
      rr(8.4, 19, 4, 1, 0.5),
      rr(13.4, 19, 4, 1, 0.5),
      rr(3.4, 21.2, 12, 0.9, 0.45), // caption
    ),
    detailFill: INK,
    defaultW: 340,
  },
  {
    id: "billboard",
    name: "Billboard",
    category: "promo",
    artH: 17,
    screen: { x: 3.2, y: 2.2, w: 17.6, h: 6.6 },
    body: P(
      rr(2, 1, 20, 9, 0.8), // panel
      rr(6, 10, 1.6, 6, 0.3), // posts
      rr(16.4, 10, 1.6, 6, 0.3),
    ),
    bodyFill: INK,
    detail: P(
      rr(5.4, 1.05, 1.2, 0.7, 0.2), // top lights
      rr(11.4, 1.05, 1.2, 0.7, 0.2),
      rr(17.4, 1.05, 1.2, 0.7, 0.2),
      rr(4.5, 10.5, 15, 1, 0.3), // crossbar
    ),
    detailFill: PAPER,
    defaultW: 480,
  },
  {
    id: "poster-frame",
    name: "Poster frame",
    category: "print",
    artH: 32,
    screen: { x: 4, y: 3, w: 16, h: 26 },
    body: rr(2, 1, 20, 30, 1),
    bodyFill: INK,
    detail: circ(12, 0.5, 0.45), // hanging nail
    detailFill: DETAIL_DARK,
    defaultW: 300,
  },
  {
    id: "business-card",
    name: "Business card",
    category: "print",
    artH: 15,
    screen: { x: 2.4, y: 4.9, w: 11, h: 5.2 },
    body: rr(1, 3.5, 22, 8, 1),
    bodyFill: PAPER_DARK,
    detail: P(
      circ(17.5, 6.3, 1.3), // logo mark
      rr(15.6, 8.4, 5, 0.9, 0.45), // contact lines
      rr(15.6, 9.9, 3.6, 0.9, 0.45),
    ),
    detailFill: INK,
    defaultW: 380,
  },
  {
    id: "book",
    name: "Book / ebook",
    category: "print",
    artH: 30,
    screen: { x: 8.6, y: 4, w: 9.4, h: 16 },
    body: P(
      rr(5, 1, 15, 28, 1), // cover
      rr(5, 1, 2.4, 28, 0.8), // spine
    ),
    bodyFill: INK,
    detail: P(
      rr(20, 2.5, 1.2, 25, 0.3), // page block
      rr(8.6, 22, 9.4, 1, 0.5), // title bars
      rr(8.6, 23.8, 6, 0.9, 0.45),
    ),
    detailFill: PAPER_LIGHT,
    defaultW: 280,
  },
  {
    id: "coffee-mug",
    name: "Coffee mug",
    category: "promo",
    artH: 26,
    screen: { x: 7.6, y: 10.5, w: 6.8, h: 7 },
    body: P(
      rr(6, 7, 10, 14, 2.5), // cup
      ell(11, 7, 5, 1.2), // rim
      // Handle as a filled C — no hole needed.
      "M16 10.5 C19.5 10.5 19.5 16.5 16 16.5 L16 14.5 C17.8 14.5 17.8 12.5 16 12.5 Z",
    ),
    bodyFill: VIOLET,
    detail: P(
      ell(11, 22.6, 6.5, 1.1), // saucer
      poly([
        [9.3, 5.6],
        [10, 5.6],
        [9.5, 4.4],
        [10.2, 3.2],
        [9.5, 3.2],
        [8.8, 4.4],
      ]), // steam ribbons
      poly([
        [12.3, 5.6],
        [13, 5.6],
        [12.5, 4.4],
        [13.2, 3.2],
        [12.5, 3.2],
        [11.8, 4.4],
      ]),
    ),
    detailFill: PAPER_DARK,
    defaultW: 260,
  },
  {
    id: "t-shirt",
    name: "T-shirt",
    category: "promo",
    artH: 24,
    screen: { x: 9.3, y: 9.5, w: 5.4, h: 6.5 },
    body: "M8.5 3.5 L5 5 L2.5 9.5 L6 11 L7.5 8.5 L7.5 21 L16.5 21 L16.5 8.5 L18 11 L21.5 9.5 L19 5 L15.5 3.5 C14 5 10 5 8.5 3.5 Z",
    bodyFill: INK,
    detail: P(
      "M8.5 3.5 C10 5 14 5 15.5 3.5 L15.5 4.8 C14 6.3 10 6.3 8.5 4.8 Z", // collar rib
      poly([
        [3.1, 9.3],
        [6.2, 10.7],
        [5.9, 11.4],
        [2.8, 10],
      ]), // sleeve hems
      poly([
        [20.9, 9.3],
        [17.8, 10.7],
        [18.1, 11.4],
        [21.2, 10],
      ]),
    ),
    detailFill: DETAIL_DARK,
    defaultW: 300,
  },
  {
    id: "shopping-bag",
    name: "Shopping bag",
    category: "promo",
    artH: 28,
    screen: { x: 8.2, y: 12.5, w: 7.6, h: 8 },
    body: P(
      poly([
        [7, 9],
        [17, 9],
        [18.2, 24],
        [5.8, 24],
      ]),
      rr(6.8, 8, 10.4, 1.8, 0.6), // folded top
    ),
    bodyFill: VIOLET,
    detail: P(
      // Ribbon handles (filled U shapes).
      "M9.3 8.8 L9.3 6.4 Q9.3 5 10.7 5 Q12.1 5 12.1 6.4 L12.1 8.8 L11.3 8.8 L11.3 6.4 Q11.3 5.8 10.7 5.8 Q10.1 5.8 10.1 6.4 L10.1 8.8 Z",
      "M12.1 8.8 L12.1 6.4 Q12.1 5 13.5 5 Q14.9 5 14.9 6.4 L14.9 8.8 L14.1 8.8 L14.1 6.4 Q14.1 5.8 13.5 5.8 Q12.9 5.8 12.9 6.4 L12.9 8.8 Z",
    ),
    detailFill: PAPER,
    defaultW: 280,
  },
  {
    id: "app-icon-grid",
    name: "App icon grid",
    category: "device",
    artH: 24,
    screen: { x: 10.2, y: 10.2, w: 5.6, h: 5.6 },
    body: rr(1.5, 1.5, 21, 21, 4),
    bodyFill: INK,
    detail: appIconGrid(), // 8 stone icons around the center screen slot
    detailFill: DETAIL_MID,
    defaultW: 320,
  },
  {
    id: "smartwatch",
    name: "Smartwatch",
    category: "wearable",
    artH: 38,
    screen: { x: 8.2, y: 11, w: 7.6, h: 16 },
    body: rr(6.5, 8, 11, 22, 4),
    bodyFill: INK,
    detail: P(
      poly([
        [9, 1],
        [15, 1],
        [14, 8.5],
        [10, 8.5],
      ]), // top strap
      poly([
        [10, 29.5],
        [14, 29.5],
        [15, 37],
        [9, 37],
      ]), // bottom strap
      rr(17.5, 14, 1.4, 3, 0.7), // crown
      rr(17.5, 19.5, 1.2, 4, 0.6), // side button
    ),
    detailFill: DETAIL_MID,
    defaultW: 220,
  },
  {
    id: "tv-widescreen",
    name: "TV · widescreen",
    category: "device",
    artH: 16,
    screen: { x: 2.4, y: 3.4, w: 19.2, h: 7.7 },
    body: P(
      rr(1, 2, 22, 10.5, 0.8), // bezel
      rr(11.2, 12.5, 1.6, 1.8, 0.4), // neck
      rr(8, 14.3, 8, 1.2, 0.6), // base
    ),
    bodyFill: INK,
    detail: circ(12, 11.7, 0.4), // power LED
    detailFill: VIOLET,
    defaultW: 460,
  },
  {
    id: "signage-board",
    name: "Signage board",
    category: "promo",
    artH: 28,
    screen: { x: 6.6, y: 3.6, w: 10.8, h: 11.8 },
    body: P(
      rr(5, 2, 14, 15, 1), // board
      poly([
        [6, 17],
        [9, 17],
        [8, 27],
        [5, 27],
      ]), // legs
      poly([
        [15, 17],
        [18, 17],
        [19, 27],
        [16, 27],
      ]),
    ),
    bodyFill: INK,
    detail: rr(8, 21, 8, 1, 0.3), // crossbar
    detailFill: DETAIL_MID,
    defaultW: 300,
  },
  {
    id: "packaging-box",
    name: "Packaging box",
    category: "promo",
    artH: 24,
    screen: { x: 11, y: 12.5, w: 3.8, h: 5.5 },
    body: rr(4, 10, 12, 11, 0.5), // front face
    bodyFill: INK,
    detail: P(
      poly([
        [4, 10],
        [7, 6.5],
        [19, 6.5],
        [16, 10],
      ]), // top face
      poly([
        [16, 10],
        [19, 6.5],
        [19, 17.5],
        [16, 21],
      ]), // side face
      rr(9.4, 10, 1.2, 11, 0.2), // tape strip
    ),
    detailFill: DETAIL_LIGHT,
    defaultW: 320,
  },
];

export const MOCKUP_FRAME_MAP: Record<string, MockupFrameDef> = Object.fromEntries(
  MOCKUP_FRAMES.map((f) => [f.id, f]),
);

// ── Screen placeholder ────────────────────────────────────────────────────
// A light "YOUR DESIGN" tile (own artwork) used as the screen image src
// until the user picks "Set screen image". Stretches to any screen rect.

const PLACEHOLDER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="90" viewBox="0 0 120 90"><rect x="1" y="1" width="118" height="88" rx="6" fill="#f5f4f2"/><rect x="6" y="6" width="108" height="78" rx="4" fill="none" stroke="#a78bfa" stroke-width="2" stroke-dasharray="7 5"/><path d="M50 44 l9 -11 6.5 7.5 5 -5.5 8.5 9 z" fill="#d6d3d1"/><circle cx="73" cy="33" r="4.5" fill="#d6d3d1"/><text x="60" y="70" text-anchor="middle" font-family="system-ui, sans-serif" font-size="9" letter-spacing="2.5" fill="#a8a29e">YOUR DESIGN</text></svg>`;

export const SCREEN_PLACEHOLDER_SRC =
  "data:image/svg+xml;charset=utf-8," + encodeURIComponent(PLACEHOLDER_SVG);

// ── Builders ──────────────────────────────────────────────────────────────

export interface MockupTag {
  frameId: string;
  role: "frame" | "detail" | "screen";
}

function tag(frameId: string, role: MockupTag["role"]): Record<string, unknown> {
  return { mockup: { frameId, role } satisfies MockupTag };
}

const baseEl = (name: string, x: number, y: number) => ({
  id: newId("mockup"),
  name,
  x,
  y,
  rotation: 0,
  opacity: 1,
  visible: true,
  locked: false,
});

/**
 * Build the insertable element set for a frame: [body svg, detail svg?,
 * screen image]. The screen is LAST (top of z-order) so clicking the
 * screen area selects it. Throws on unknown frame id.
 */
export function buildMockupElements(
  frameId: string,
  pageW: number,
  pageH: number,
): DesignElement[] {
  const def = MOCKUP_FRAME_MAP[frameId];
  if (!def) throw new Error(`unknown mockup frame: ${frameId}`);

  const scale = def.defaultW / 24;
  const w = def.defaultW;
  const h = Math.round(def.artH * scale * 100) / 100;
  const x = Math.round(((pageW - w) / 2) * 100) / 100;
  const y = Math.round(((pageH - h) / 2) * 100) / 100;

  const els: DesignElement[] = [];
  els.push({
    ...baseEl(`${def.name} frame`, x, y),
    type: "svg",
    path: def.body,
    width: w,
    height: h,
    fill: def.bodyFill,
    custom: tag(def.id, "frame"),
  });
  if (def.detail) {
    els.push({
      ...baseEl(`${def.name} details`, x, y),
      type: "svg",
      path: def.detail,
      width: w,
      height: h,
      fill: def.detailFill ?? DETAIL_MID,
      custom: tag(def.id, "detail"),
    });
  }
  els.push({
    ...baseEl(`${def.name} screen`, 0, 0),
    type: "image",
    src: SCREEN_PLACEHOLDER_SRC,
    x: Math.round((x + def.screen.x * scale) * 100) / 100,
    y: Math.round((y + def.screen.y * scale) * 100) / 100,
    width: Math.round(def.screen.w * scale * 100) / 100,
    height: Math.round(def.screen.h * scale * 100) / 100,
    cornerRadius: 0,
    custom: tag(def.id, "screen"),
  });
  return els;
}

/** True when the element is a mockup screen (the settable image). */
export function isMockupScreen(el: DesignElement): el is ImageElement {
  if (el.type !== "image") return false;
  const mockup = (el.custom as { mockup?: { role?: unknown } } | undefined)?.mockup;
  return !!mockup && mockup.role === "screen";
}

/** Read the mockup tag off any element (undefined when not a mockup part). */
export function mockupTagOf(el: DesignElement): MockupTag | undefined {
  const mockup = (el.custom as { mockup?: MockupTag } | undefined)?.mockup;
  return mockup && typeof mockup.frameId === "string" ? mockup : undefined;
}
