// ShapesOS — Phase 18.1 (WS=desk): the desktop grid layout (PURE, client-safe).
//
// A layout is { version: 1, widgets: [{ id, widget, x, y, w, h }] } on a
// 12-column grid of GRID_ROW_PX rows. It is stored per member per workspace
// (user_desktop_layouts.layout) and validated here on every write:
//   - shape (zod), known widget ids, unique placement ids, ≤ MAX_WIDGETS;
//   - bounds: 0 ≤ x, x + w ≤ 12, 0 ≤ y, y + h ≤ GRID_MAX_ROWS;
//   - each widget within its registry min/max size;
//   - no two widgets overlap;
//   - the member's role may place the widget (minRole).
// Reads go through sanitizeLayout(): a stored layout that no longer fits
// (a widget removed from the registry, a role change) degrades to what still
// fits instead of breaking Home; an empty or broken one falls back to the
// role's default.
//
// Editing helpers (moveBy / resizeBy / placeWidget / removeWidget) keep the
// grid valid by pushing colliding widgets down and then compacting upwards —
// the same result for pointer drags and for the keyboard (arrow keys), so no
// interaction is drag-only.

import { z } from "zod";
import {
  GRID_COLS,
  GRID_MAX_ROWS,
  MAX_WIDGETS,
  WIDGETS,
  WIDGET_IDS,
  deskRoleAtLeast,
  isWidgetId,
  type DeskRole,
  type WidgetId,
} from "./widgets";

export const LAYOUT_VERSION = 1;

export const PlacementSchema = z.object({
  /** Placement id (unique in the layout; a widget may appear once). */
  id: z.string().trim().min(1).max(64).regex(/^[a-z0-9-]+$/),
  widget: z.enum(WIDGET_IDS),
  x: z.number().int(),
  y: z.number().int(),
  w: z.number().int(),
  h: z.number().int(),
});

export const LayoutSchema = z.object({
  version: z.literal(LAYOUT_VERSION),
  widgets: z.array(PlacementSchema).max(MAX_WIDGETS),
});

export type Placement = z.infer<typeof PlacementSchema>;
export type DesktopLayout = z.infer<typeof LayoutSchema>;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export interface LayoutIssue {
  code: "shape" | "unknown_widget" | "duplicate" | "bounds" | "size" | "overlap" | "role";
  message: string;
  placementId?: string;
}

/** Bounds + registry size limits for one placement (no overlap check). */
export function placementIssues(p: Placement): LayoutIssue[] {
  const out: LayoutIssue[] = [];
  const def = WIDGETS[p.widget];
  if (p.x < 0 || p.y < 0 || p.x + p.w > GRID_COLS || p.y + p.h > GRID_MAX_ROWS) {
    out.push({ code: "bounds", placementId: p.id, message: `${def.title} is outside the grid.` });
  }
  if (p.w < def.minSize.w || p.h < def.minSize.h || p.w > def.maxSize.w || p.h > def.maxSize.h) {
    out.push({
      code: "size",
      placementId: p.id,
      message: `${def.title} must be ${def.minSize.w}–${def.maxSize.w} columns wide and ${def.minSize.h}–${def.maxSize.h} rows tall.`,
    });
  }
  return out;
}

/**
 * Validate a layout for a member with `role`. Returns the parsed layout when
 * it is valid, or every issue found (writes are refused with these).
 */
export function validateLayout(
  input: unknown,
  role: string | null | undefined,
): { ok: true; layout: DesktopLayout } | { ok: false; issues: LayoutIssue[] } {
  const parsed = LayoutSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const unknownWidget = parsed.error.issues.some((i) => i.path.includes("widget"));
    return {
      ok: false,
      issues: [
        {
          code: unknownWidget ? "unknown_widget" : "shape",
          message: unknownWidget ? "That widget does not exist." : `Layout is malformed (${first?.path.join(".") || "root"}: ${first?.message ?? "invalid"}).`,
        },
      ],
    };
  }
  const layout = parsed.data;
  const issues: LayoutIssue[] = [];
  const ids = new Set<string>();
  const kinds = new Set<WidgetId>();
  for (const p of layout.widgets) {
    if (ids.has(p.id) || kinds.has(p.widget)) {
      issues.push({ code: "duplicate", placementId: p.id, message: `${WIDGETS[p.widget].title} is on the desktop twice.` });
    }
    ids.add(p.id);
    kinds.add(p.widget);
    if (!deskRoleAtLeast(role, WIDGETS[p.widget].minRole)) {
      issues.push({ code: "role", placementId: p.id, message: `${WIDGETS[p.widget].title} needs the ${WIDGETS[p.widget].minRole} role.` });
    }
    issues.push(...placementIssues(p));
  }
  for (let i = 0; i < layout.widgets.length; i++) {
    for (let j = i + 1; j < layout.widgets.length; j++) {
      const a = layout.widgets[i]!;
      const b = layout.widgets[j]!;
      if (overlaps(a, b)) {
        issues.push({ code: "overlap", placementId: b.id, message: `${WIDGETS[a.widget].title} and ${WIDGETS[b.widget].title} overlap.` });
      }
    }
  }
  return issues.length ? { ok: false, issues } : { ok: true, layout };
}

// ---------------------------------------------------------------------------
// Placement engine
// ---------------------------------------------------------------------------

function clampToWidget(p: Placement): Placement {
  const def = WIDGETS[p.widget];
  const w = Math.min(Math.max(p.w, def.minSize.w), def.maxSize.w, GRID_COLS);
  const h = Math.min(Math.max(p.h, def.minSize.h), def.maxSize.h);
  const x = Math.min(Math.max(p.x, 0), GRID_COLS - w);
  const y = Math.min(Math.max(p.y, 0), GRID_MAX_ROWS - h);
  return { ...p, x, y, w, h };
}

/** Reading order: top to bottom, then left to right. */
export function byReadingOrder(a: Rect, b: Rect): number {
  return a.y - b.y || a.x - b.x;
}

/**
 * Resolve collisions: `fixed` keeps its spot; every other widget that hits
 * something is pushed down below it, then everything floats up as far as it
 * can (gravity). Deterministic, so pointer and keyboard edits agree.
 */
export function settle(widgets: Placement[], fixedId?: string): Placement[] {
  const fixed = fixedId ? widgets.find((w) => w.id === fixedId) : undefined;
  const others = widgets.filter((w) => w !== fixed).sort(byReadingOrder);
  const placed: Placement[] = fixed ? [fixed] : [];
  for (const w of others) {
    let cur = { ...w };
    // Push down until it collides with nothing already placed.
    for (let guard = 0; guard < GRID_MAX_ROWS * 2 && placed.some((p) => overlaps(p, cur)); guard++) {
      const blocker = placed.filter((p) => overlaps(p, cur)).reduce((m, p) => Math.max(m, p.y + p.h), 0);
      cur = { ...cur, y: blocker };
    }
    placed.push(cur);
  }
  return compact(placed, fixedId);
}

/** Float every widget (except `pinnedId`) up while the space above is free. */
export function compact(widgets: Placement[], pinnedId?: string): Placement[] {
  const sorted = [...widgets].sort(byReadingOrder);
  const out: Placement[] = [];
  const pinned = pinnedId ? sorted.find((w) => w.id === pinnedId) : undefined;
  if (pinned) out.push(pinned);
  for (const w of sorted) {
    if (w === pinned) continue;
    let cur = { ...w };
    while (cur.y > 0 && !out.some((p) => overlaps(p, { ...cur, y: cur.y - 1 }))) cur = { ...cur, y: cur.y - 1 };
    out.push(cur);
  }
  return out.sort(byReadingOrder);
}

/** Put `p` exactly at its rect (clamped to the grid and its size limits) and settle the rest around it. */
export function placeWidget(layout: DesktopLayout, p: Placement): DesktopLayout {
  const next = clampToWidget(p);
  const rest = layout.widgets.filter((w) => w.id !== p.id);
  return { ...layout, widgets: settle([...rest, next], next.id) };
}

/** Keyboard / button move by whole cells. */
export function moveBy(layout: DesktopLayout, id: string, dx: number, dy: number): DesktopLayout {
  const cur = layout.widgets.find((w) => w.id === id);
  if (!cur) return layout;
  // Moving up past a neighbour: jump over it so ↑ always makes progress.
  let y = cur.y + dy;
  if (dy < 0) {
    const above = layout.widgets.filter((w) => w.id !== id && overlaps(w, { ...cur, y }));
    if (above.length) y = Math.min(...above.map((w) => w.y));
  }
  return placeWidget(layout, { ...cur, x: cur.x + dx, y: Math.max(0, y) });
}

/** Keyboard / button resize by whole cells (the top-left corner stays). */
export function resizeBy(layout: DesktopLayout, id: string, dw: number, dh: number): DesktopLayout {
  const cur = layout.widgets.find((w) => w.id === id);
  if (!cur) return layout;
  return placeWidget(layout, { ...cur, w: cur.w + dw, h: cur.h + dh });
}

export function removeWidget(layout: DesktopLayout, id: string): DesktopLayout {
  return { ...layout, widgets: compact(layout.widgets.filter((w) => w.id !== id)) };
}

/** The first free slot (reading order) where a widget of `size` fits. */
export function firstFreeSlot(widgets: Rect[], size: { w: number; h: number }): { x: number; y: number } {
  for (let y = 0; y <= GRID_MAX_ROWS - size.h; y++) {
    for (let x = 0; x <= GRID_COLS - size.w; x++) {
      const r = { x, y, ...size };
      if (!widgets.some((w) => overlaps(w, r))) return { x, y };
    }
  }
  return { x: 0, y: Math.max(0, GRID_MAX_ROWS - size.h) };
}

/** Add a widget at its default size in the first free slot (no-op when already placed). */
export function addWidget(layout: DesktopLayout, widget: WidgetId): DesktopLayout {
  if (layout.widgets.some((w) => w.widget === widget) || layout.widgets.length >= MAX_WIDGETS) return layout;
  const size = WIDGETS[widget].defaultSize;
  const slot = firstFreeSlot(layout.widgets, size);
  return { ...layout, widgets: [...layout.widgets, { id: widget, widget, ...slot, ...size }].sort(byReadingOrder) };
}

// ---------------------------------------------------------------------------
// Defaults per role + sanitizing stored layouts
// ---------------------------------------------------------------------------

/** Rows of widgets per role; each row is packed left to right at default sizes. */
const DEFAULT_ROWS: Record<DeskRole, WidgetId[][]> = {
  owner: [["briefing", "needs-you"], ["agents", "running"], ["calendar", "cash", "pipeline"], ["attention", "suggestions"], ["projects", "key-numbers"]],
  admin: [["briefing", "needs-you"], ["agents", "running"], ["calendar", "cash", "pipeline"], ["attention", "suggestions"], ["projects", "key-numbers"]],
  editor: [["briefing", "needs-you"], ["agents", "running"], ["calendar", "inbox", "pipeline"], ["attention", "suggestions"], ["projects", "key-numbers"]],
  viewer: [["briefing", "needs-you"], ["agents", "running"], ["attention", "calendar"], ["projects", "key-numbers"]],
};

export function defaultLayoutFor(role: string | null | undefined): DesktopLayout {
  const r: DeskRole = (["owner", "admin", "editor", "viewer"] as const).find((k) => k === role) ?? "viewer";
  const widgets: Placement[] = [];
  let y = 0;
  for (const row of DEFAULT_ROWS[r]) {
    let x = 0;
    let rowH = 0;
    for (const id of row) {
      const def = WIDGETS[id];
      if (!deskRoleAtLeast(r, def.minRole)) continue;
      const w = Math.min(def.defaultSize.w, GRID_COLS - x);
      widgets.push({ id, widget: id, x, y, w, h: def.defaultSize.h });
      x += w;
      rowH = Math.max(rowH, def.defaultSize.h);
    }
    // A row whose widgets don't fill 12 columns: stretch the last one.
    const last = widgets[widgets.length - 1];
    if (last && last.y === y && x < GRID_COLS) {
      const def = WIDGETS[last.widget];
      last.w = Math.min(def.maxSize.w, last.w + (GRID_COLS - x));
    }
    y += rowH;
  }
  return { version: LAYOUT_VERSION, widgets: compact(widgets) };
}

/**
 * A stored layout, made safe to render for `role`: unknown widgets, widgets
 * the role may no longer see and duplicates are dropped, every placement is
 * clamped into the grid and its size limits, overlaps are settled. Falls
 * back to the role default when nothing usable is left.
 */
export function sanitizeLayout(stored: unknown, role: string | null | undefined): DesktopLayout {
  const raw = (stored && typeof stored === "object" ? (stored as { widgets?: unknown }).widgets : null) ?? null;
  if (!Array.isArray(raw)) return defaultLayoutFor(role);
  const seen = new Set<WidgetId>();
  const kept: Placement[] = [];
  for (const item of raw.slice(0, MAX_WIDGETS * 2)) {
    const p = PlacementSchema.safeParse(item);
    if (!p.success || !isWidgetId(p.data.widget)) continue;
    if (seen.has(p.data.widget) || !deskRoleAtLeast(role, WIDGETS[p.data.widget].minRole)) continue;
    seen.add(p.data.widget);
    kept.push(clampToWidget(p.data));
    if (kept.length >= MAX_WIDGETS) break;
  }
  if (kept.length === 0) return defaultLayoutFor(role);
  return { version: LAYOUT_VERSION, widgets: settle(kept) };
}

/** Grid height in rows (for the container). */
export function layoutRows(layout: DesktopLayout): number {
  return layout.widgets.reduce((m, w) => Math.max(m, w.y + w.h), 0);
}
