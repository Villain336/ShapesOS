// ShapesOS Desktop: coordinate maths for screenshots, points and drawings.
//
// Three coordinate spaces meet here:
//   * screenshot pixels: what the model sees (a JPEG per display, possibly
//     downscaled), reported per image as width/height/scaleFactor where
//     scaleFactor = image pixels per screen point;
//   * display-local points (DIP): what a `point { screen, x, y }` carries
//     ("already scaled" by the server) and what an overlay window's CSS
//     pixels are, because each overlay exactly covers one display's bounds;
//   * global DIP: Electron's screen API space across all monitors. Displays
//     left of / above the primary have NEGATIVE origins.
// Inside the ShapesOS window an element's rect comes from the page in CSS px
// relative to the viewport; with the window's content bounds (global DIP) and
// the page zoom factor it becomes global DIP, then display-local.
//
// Everything is pure so it can be unit-tested for DPI, multiple monitors and
// negative origins.

import type { Point2, UiMapEntry, UiMapRect } from "./contract";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The subset of Electron's Display we rely on. */
export interface DisplayLike {
  id: number;
  bounds: Rect;
  scaleFactor: number;
}

/** A display as numbered in a turn (`screen` index) — the order the desktop sent. */
export interface NumberedDisplay extends DisplayLike {
  screen: number;
  primary: boolean;
}

/**
 * Number displays for a turn: primary first, then the rest left to right,
 * top to bottom. Stable for a given layout, so `screen` in a model's answer
 * matches the screenshot it was given.
 */
export function numberDisplays(displays: readonly DisplayLike[], primaryId: number): NumberedDisplay[] {
  const sorted = [...displays].sort((a, b) => {
    if (a.id === primaryId) return -1;
    if (b.id === primaryId) return 1;
    return a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y || a.id - b.id;
  });
  return sorted.map((d, i) => ({ ...d, screen: i, primary: d.id === primaryId }));
}

/** Image pixels per display point for a screenshot of `display` at `imageWidth` px. */
export function imageScale(display: DisplayLike, imageWidth: number): number {
  if (display.bounds.width <= 0) return display.scaleFactor;
  return imageWidth / display.bounds.width;
}

/**
 * The thumbnail size to ask desktopCapturer for, so the largest display fits
 * `maxEdge` pixels on its long edge (Claude's vision sweet spot is ~1568px)
 * without upscaling beyond the display's physical pixels.
 */
export function captureSize(displays: readonly DisplayLike[], maxEdge = 1568): { width: number; height: number } {
  let w = 1;
  let h = 1;
  for (const d of displays) {
    const pw = Math.round(d.bounds.width * d.scaleFactor);
    const ph = Math.round(d.bounds.height * d.scaleFactor);
    const s = Math.min(1, maxEdge / Math.max(pw, ph));
    w = Math.max(w, Math.round(pw * s));
    h = Math.max(h, Math.round(ph * s));
  }
  return { width: w, height: h };
}

/** Screenshot pixel → display-local point. */
export function imageToLocal(p: Point2, scale: number): Point2 {
  return { x: p.x / scale, y: p.y / scale };
}

/** Display-local point → global DIP. */
export function localToGlobal(p: Point2, display: DisplayLike): Point2 {
  return { x: display.bounds.x + p.x, y: display.bounds.y + p.y };
}

/** Global DIP → display-local point. */
export function globalToLocal(p: Point2, display: DisplayLike): Point2 {
  return { x: p.x - display.bounds.x, y: p.y - display.bounds.y };
}

function contains(r: Rect, p: Point2): boolean {
  return p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;
}

/** The display containing a global point, else the nearest one (like screen.getDisplayNearestPoint). */
export function displayForPoint<T extends DisplayLike>(displays: readonly T[], p: Point2): T | null {
  let best: T | null = null;
  let bestDist = Infinity;
  for (const d of displays) {
    if (contains(d.bounds, p)) return d;
    const dx = Math.max(d.bounds.x - p.x, 0, p.x - (d.bounds.x + d.bounds.width));
    const dy = Math.max(d.bounds.y - p.y, 0, p.y - (d.bounds.y + d.bounds.height));
    const dist = dx * dx + dy * dy;
    if (dist < bestDist) {
      bestDist = dist;
      best = d;
    }
  }
  return best;
}

/** Keep a display-local point on its display (a model can answer slightly outside). */
export function clampLocal(p: Point2, display: DisplayLike): Point2 {
  const maxX = Math.max(0, display.bounds.width - 1);
  const maxY = Math.max(0, display.bounds.height - 1);
  return { x: Math.min(Math.max(p.x, 0), maxX), y: Math.min(Math.max(p.y, 0), maxY) };
}

/**
 * Where a `point { screen, x, y }` lands: the display with that turn index
 * and the clamped display-local point (= overlay CSS px). Unknown screen →
 * null (the event is ignored rather than drawn on the wrong monitor).
 */
export function resolveScreenPoint(
  numbered: readonly NumberedDisplay[],
  ev: { screen: number; x: number; y: number },
): { display: NumberedDisplay; local: Point2 } | null {
  const display = numbered.find((d) => d.screen === ev.screen);
  if (!display || !Number.isFinite(ev.x) || !Number.isFinite(ev.y)) return null;
  return { display, local: clampLocal({ x: ev.x, y: ev.y }, display) };
}

/**
 * A uiMap rect (CSS px, relative to the page viewport) → global DIP, using
 * the ShapesOS window's content bounds (global DIP) and the page zoom factor
 * (CSS px × zoom = DIP).
 */
export function uiRectToGlobal(rect: UiMapRect, contentBounds: Rect, zoomFactor = 1): Rect {
  return {
    x: contentBounds.x + rect.x * zoomFactor,
    y: contentBounds.y + rect.y * zoomFactor,
    width: rect.w * zoomFactor,
    height: rect.h * zoomFactor,
  };
}

export function rectCenter(r: Rect): Point2 {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

/**
 * `point { elementId }` → the display and display-local point at the
 * element's centre. Missing id, or an element outside every display → null.
 */
export function resolveElementPoint<T extends DisplayLike>(
  uiMap: readonly UiMapEntry[],
  elementId: string,
  contentBounds: Rect,
  zoomFactor: number,
  displays: readonly T[],
): { display: T; local: Point2; rect: Rect } | null {
  const entry = uiMap.find((e) => e.id === elementId);
  if (!entry) return null;
  const g = uiRectToGlobal(entry.rect, contentBounds, zoomFactor);
  const c = rectCenter(g);
  const display = displayForPoint(displays, c);
  if (!display) return null;
  return { display, local: globalToLocal(c, display), rect: g };
}

/**
 * The uiMap as sent to the server: rects converted to points local to the
 * display that holds the ShapesOS window (the screen index the model sees),
 * dropping entries that are off every display or zero-sized.
 */
export function uiMapForTurn(
  uiMap: readonly UiMapEntry[],
  contentBounds: Rect,
  zoomFactor: number,
  numbered: readonly NumberedDisplay[],
): { screen: number | null; entries: UiMapEntry[] } {
  const display = displayForPoint(numbered, rectCenter(contentBounds));
  if (!display) return { screen: null, entries: [] };
  const entries: UiMapEntry[] = [];
  for (const e of uiMap.slice(0, 400)) {
    if (!(e.rect.w > 0 && e.rect.h > 0)) continue;
    const g = uiRectToGlobal(e.rect, contentBounds, zoomFactor);
    const local = globalToLocal({ x: g.x, y: g.y }, display);
    entries.push({
      id: e.id.slice(0, 200),
      label: e.label.slice(0, 200),
      role: e.role.slice(0, 40),
      rect: { x: Math.round(local.x), y: Math.round(local.y), w: Math.round(g.width), h: Math.round(g.height) },
    });
  }
  return { screen: display.screen, entries };
}

/**
 * Windows reports some positions (e.g. a native window's bounds from
 * get-windows) in PHYSICAL pixels. With per-monitor DPI each display has its
 * own scale, so convert relative to the display whose physical rect holds
 * the point: physicalOrigin is `nativeOrigin` (or bounds × scale on a single
 * display).
 */
export function physicalToGlobal(
  p: Point2,
  displays: readonly (DisplayLike & { nativeOrigin?: Point2 })[],
): Point2 {
  for (const d of displays) {
    const o = d.nativeOrigin ?? { x: d.bounds.x * d.scaleFactor, y: d.bounds.y * d.scaleFactor };
    const r = { x: o.x, y: o.y, width: d.bounds.width * d.scaleFactor, height: d.bounds.height * d.scaleFactor };
    if (contains(r, p)) {
      return { x: d.bounds.x + (p.x - o.x) / d.scaleFactor, y: d.bounds.y + (p.y - o.y) / d.scaleFactor };
    }
  }
  const d = displays[0];
  if (!d) return p;
  return { x: p.x / d.scaleFactor, y: p.y / d.scaleFactor };
}

/** Where to put a card (proposal, dictation) near a point without leaving the display. */
export function placeCard(
  anchor: Point2,
  card: { width: number; height: number },
  display: DisplayLike,
  gap = 16,
): Point2 {
  const W = display.bounds.width;
  const H = display.bounds.height;
  let x = anchor.x + gap;
  let y = anchor.y + gap;
  if (x + card.width > W - 8) x = anchor.x - gap - card.width;
  if (y + card.height > H - 8) y = anchor.y - gap - card.height;
  return { x: Math.max(8, Math.min(x, W - card.width - 8)), y: Math.max(8, Math.min(y, H - card.height - 8)) };
}
