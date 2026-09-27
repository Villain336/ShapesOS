// Marketr — Phase 11 "Canvas": design document state store.
// zustand vanilla-style store (no React imports here). History = immutable
// document snapshots; selection/zoom never touch history.

import { create } from "zustand";

import {
  blankDocument,
  newId,
  type DesignDocument,
  type DesignElement,
  type DesignPage,
} from "./types";
import { scalePage } from "./magic-resize";
import { chartSize } from "./chart-math";
import {
  applyFragmentStyle as applyFragmentStyleTo,
  type FragmentStyleInput,
} from "./rich-text";

const HISTORY_CAP = 50;
const ZOOM_MIN = 0.1;
const ZOOM_MAX = 4;

export type ZOrderDir = "front" | "back" | "forward" | "backward";
export type AlignEdge =
  | "left"
  | "center-x"
  | "right"
  | "top"
  | "center-y"
  | "bottom";

export interface DesignState {
  document: DesignDocument | null;
  activePageId: string | null;
  selectedIds: string[];
  zoom: number;
  past: DesignDocument[];
  future: DesignDocument[];
  dirty: boolean;

  loadDocument(doc: DesignDocument): void;
  newDocument(width: number, height: number, background?: string): void;

  addPage(): void;
  duplicatePage(id: string): void;
  removePage(id: string): void;
  renamePage(id: string, name: string): void;
  /**
   * Append externally-built pages (e.g. AI-generated drafts) with fresh ids.
   * The first appended page becomes active. Always a draft — the human edits.
   */
  appendPages(pages: DesignPage[]): void;
  setActivePage(id: string): void;
  setPageBackground(id: string, color: string): void;
  setPageSize(id: string, w: number, h: number): void;
  /**
   * "Magic resize": convert a page to new dimensions, scaling every element's
   * geometry proportionally (see lib/design/magic-resize.ts). A page-level
   * operation — locked elements resize too. Runs through commit(), so it is a
   * single undoable step. Returns per-page stats (for the toast) or null when
   * the page or dimensions are invalid.
   */
  magicResize(
    pageId: string,
    newWidth: number,
    newHeight: number,
  ): { lockedCount: number; elementCount: number } | null;

  addElement(el: DesignElement): void;
  updateElement(id: string, patch: Partial<DesignElement>): void;
  removeElements(ids: string[]): void;
  duplicateElements(ids: string[]): void;
  /**
   * FEATURE 1 — richer text. Apply a partial style to the character range
   * [start, end) of a text element, building the fragment model (created
   * from plain text when absent). No-op when the range is empty, out of
   * bounds, or the style changes nothing. Undoable.
   */
  applyFragmentStyle(
    elementId: string,
    start: number,
    end: number,
    style: FragmentStyleInput,
  ): void;
  /**
   * FEATURE 1 — drop all per-fragment styling (the element's own styling
   * remains). No-op when the element has no fragments. Undoable.
   */
  clearFragments(elementId: string): void;
  /**
   * FEATURE 1 — set the SVG path data for text-on-a-path. Falsy/blank clears
   * it. No-op when the value is unchanged. Undoable.
   */
  setTextPath(elementId: string, path?: string): void;
  moveElement(id: string, dir: ZOrderDir): void;
  alignElements(ids: string[], edge: AlignEdge): void;

  select(ids: string[], additive?: boolean): void;
  clearSelection(): void;
  setZoom(z: number): void;

  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
  markClean(): void;
}

type Set = (partial: Partial<DesignState>) => void;
type Get = () => DesignState;

/** Push the current document snapshot, apply the mutation immutably. */
function commit(
  set: Set,
  get: Get,
  next: (doc: DesignDocument) => DesignDocument,
  extra: Partial<DesignState> = {},
): void {
  const { document, past } = get();
  if (!document) return;
  const newPast = [...past, document].slice(-HISTORY_CAP);
  set({
    document: next(document),
    past: newPast,
    future: [],
    dirty: true,
    ...extra,
  });
}

function activePageOf(doc: DesignDocument, activePageId: string | null): DesignPage | null {
  if (doc.pages.length === 0) return null;
  return (
    doc.pages.find((p) => p.id === activePageId) ?? doc.pages[0] ?? null
  );
}

function withPage(
  doc: DesignDocument,
  pageId: string,
  fn: (page: DesignPage) => DesignPage,
): DesignDocument {
  return {
    ...doc,
    pages: doc.pages.map((p) => (p.id === pageId ? fn(p) : p)),
  };
}

/**
 * FEATURE 1 — fragment↔text sync guard. A wholesale `text` replacement that
 * does not carry `fragments` cannot be mapped onto the old runs, so stale
 * fragments are dropped instead of being left contradicting `text`.
 */
function applyTextPatch(
  el: DesignElement,
  patch: Partial<DesignElement>,
): DesignElement {
  const merged = { ...el, ...patch } as DesignElement;
  if (
    merged.type === "text" &&
    "text" in patch &&
    !("fragments" in patch) &&
    merged.fragments !== undefined &&
    merged.fragments.length > 0
  ) {
    merged.fragments = undefined;
  }
  return merged;
}

function textElementOf(
  document: DesignDocument | null,
  activePageId: string | null,
  elementId: string,
): { page: DesignPage; el: Extract<DesignElement, { type: "text" }> } | null {
  if (!document) return null;
  const page = activePageOf(document, activePageId);
  if (!page) return null;
  const el = page.elements.find((e) => e.id === elementId);
  if (!el || el.type !== "text") return null;
  return { page, el };
}

function emptyPage(name: string): DesignPage {
  return {
    id: newId("page"),
    name,
    width: 1080,
    height: 1080,
    background: "#FAFAF7",
    elements: [],
  };
}

/** Unrotated bounding box of an element, in page coordinates. */
function boundsOf(el: DesignElement): { x: number; y: number; w: number; h: number } {
  switch (el.type) {
    case "text": {
      const w = el.width ?? el.text.length * el.fontSize * 0.55;
      return { x: el.x, y: el.y, w, h: el.fontSize * el.lineHeight };
    }
    case "image":
      return { x: el.x, y: el.y, w: el.width, h: el.height };
    case "rect":
      return { x: el.x, y: el.y, w: el.width, h: el.height };
    case "ellipse":
      return {
        x: el.x - el.radiusX,
        y: el.y - el.radiusY,
        w: el.radiusX * 2,
        h: el.radiusY * 2,
      };
    case "svg":
      return { x: el.x, y: el.y, w: el.width, h: el.height };
    case "line": {
      const xs = el.points.filter((_, i) => i % 2 === 0);
      const ys = el.points.filter((_, i) => i % 2 === 1);
      if (xs.length === 0 || ys.length === 0) return { x: el.x, y: el.y, w: 0, h: 0 };
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      const minY = Math.min(...ys);
      const maxY = Math.max(...ys);
      return { x: el.x + minX, y: el.y + minY, w: maxX - minX, h: maxY - minY };
    }
    case "chart": {
      const { w, h } = chartSize(el);
      return { x: el.x, y: el.y, w, h };
    }
    case "qr":
      return { x: el.x, y: el.y, w: el.size, h: el.size };
  }
}

export const useDesignStore = create<DesignState>()((set, get) => ({
  document: null,
  activePageId: null,
  selectedIds: [],
  zoom: 1,
  past: [],
  future: [],
  dirty: false,

  loadDocument: (doc) => {
    set({
      document: doc,
      activePageId: doc.pages[0]?.id ?? null,
      selectedIds: [],
      past: [],
      future: [],
      dirty: false,
    });
  },

  newDocument: (width, height, background = "#FAFAF7") => {
    const doc = blankDocument(width, height, background);
    set({
      document: doc,
      activePageId: doc.pages[0]?.id ?? null,
      selectedIds: [],
      past: [],
      future: [],
      dirty: true,
    });
  },

  // ── Pages ──────────────────────────────────────────────────────────
  addPage: () => {
    const { document } = get();
    if (!document) return;
    const page = emptyPage(`Page ${document.pages.length + 1}`);
    commit(set, get, (doc) => ({ ...doc, pages: [...doc.pages, page] }), {
      activePageId: page.id,
      selectedIds: [],
    });
  },

  duplicatePage: (id) => {    const { document } = get();
    if (!document) return;
    const src = document.pages.find((p) => p.id === id);
    if (!src) return;
    const elements = src.elements.map((el) => ({
      ...el,
      id: newId("el"),
    })) as DesignElement[];
    const copy: DesignPage = {
      ...src,
      id: newId("page"),
      name: `${src.name} copy`,
      elements,
    };
    const idx = document.pages.findIndex((p) => p.id === id);
    commit(
      set,
      get,
      (doc) => ({
        ...doc,
        pages: [...doc.pages.slice(0, idx + 1), copy, ...doc.pages.slice(idx + 1)],
      }),
      { activePageId: copy.id, selectedIds: [] },
    );
  },

  appendPages: (pages) => {
    const { document } = get();
    if (!document || pages.length === 0) return;
    const base = document.pages.length;
    const fresh: DesignPage[] = pages.map((p, i) => ({
      ...p,
      id: newId("page"),
      name: p.name?.trim() ? p.name : `AI draft ${base + i + 1}`,
      elements: p.elements.map((el) => ({ ...el, id: newId("el") })),
    }));
    commit(
      set,
      get,
      (doc) => ({ ...doc, pages: [...doc.pages, ...fresh] }),
      { activePageId: fresh[0]!.id, selectedIds: [] },
    );
  },

  removePage: (id) => {
    const { document, activePageId } = get();
    if (!document || document.pages.length <= 1) return; // never remove the last page
    if (!document.pages.some((p) => p.id === id)) return;
    const pages = document.pages.filter((p) => p.id !== id);
    const nextActive =
      activePageId === id ? pages[0]!.id : activePageId;
    commit(set, get, (doc) => ({ ...doc, pages }), {
      activePageId: nextActive,
      selectedIds: [],
    });
  },

  renamePage: (id, name) => {
    commit(set, get, (doc) =>
      withPage(doc, id, (p) => ({ ...p, name })),
    );
  },

  setActivePage: (id) => {
    const { document } = get();
    if (!document || !document.pages.some((p) => p.id === id)) return;
    set({ activePageId: id, selectedIds: [] });
  },

  setPageBackground: (id, color) => {
    commit(set, get, (doc) =>
      withPage(doc, id, (p) => ({ ...p, background: color })),
    );
  },

  setPageSize: (id, w, h) => {
    commit(set, get, (doc) =>
      withPage(doc, id, (p) => ({ ...p, width: w, height: h })),
    );
  },

  magicResize: (pageId, newWidth, newHeight) => {
    const { document } = get();
    if (!document) return null;
    const page = document.pages.find((p) => p.id === pageId);
    if (!page) return null;
    if (page.width <= 0 || page.height <= 0 || newWidth <= 0 || newHeight <= 0) {
      return null;
    }
    const lockedCount = page.elements.filter((e) => e.locked).length;
    const elementCount = page.elements.length;
    commit(set, get, (doc) =>
      withPage(doc, pageId, (p) => scalePage(p, newWidth, newHeight)),
    );
    return { lockedCount, elementCount };
  },

  // ── Elements ───────────────────────────────────────────────────────
  addElement: (el) => {
    const { document, activePageId } = get();
    if (!document) return;
    const page = activePageOf(document, activePageId);
    if (!page) return;
    commit(
      set,
      get,
      (doc) => withPage(doc, page.id, (p) => ({ ...p, elements: [...p.elements, el] })),
      { selectedIds: [el.id] },
    );
  },

  updateElement: (id, patch) => {
    const { document, activePageId } = get();
    if (!document) return;
    const page = activePageOf(document, activePageId);
    if (!page || !page.elements.some((e) => e.id === id)) return;
    commit(set, get, (doc) =>
      withPage(doc, page.id, (p) => ({
        ...p,
        elements: p.elements.map((e) =>
          e.id === id ? applyTextPatch(e, patch) : e,
        ),
      })),
    );
  },

  applyFragmentStyle: (elementId, start, end, style) => {
    const { document, activePageId } = get();
    const found = textElementOf(document, activePageId, elementId);
    if (!found) return;
    const { el } = found;
    const res = applyFragmentStyleTo(
      el.fragments ?? [],
      el.text,
      start,
      end,
      style,
      {
        fontFamily: el.fontFamily,
        fontSize: el.fontSize,
        fontStyle: el.fontStyle,
        fill: el.fill,
      },
    );
    if (!res) return;
    // Both fields patched together: the sync guard only fires when `text`
    // is patched WITHOUT `fragments`.
    get().updateElement(elementId, { fragments: res.fragments, text: res.text });
  },

  clearFragments: (elementId) => {
    const { document, activePageId } = get();
    const found = textElementOf(document, activePageId, elementId);
    if (!found || !found.el.fragments || found.el.fragments.length === 0) return;
    get().updateElement(elementId, { fragments: undefined });
  },

  setTextPath: (elementId, path) => {
    const { document, activePageId } = get();
    const found = textElementOf(document, activePageId, elementId);
    if (!found) return;
    const next = path && path.trim() ? path : undefined;
    if ((found.el.textPath ?? undefined) === next) return;
    get().updateElement(elementId, { textPath: next });
  },

  removeElements: (ids) => {
    const { document, activePageId, selectedIds } = get();
    if (!document || ids.length === 0) return;
    const page = activePageOf(document, activePageId);
    if (!page) return;
    const idSet = new Set(ids);
    commit(
      set,
      get,
      (doc) =>
        withPage(doc, page.id, (p) => ({
          ...p,
          elements: p.elements.filter((e) => !idSet.has(e.id)),
        })),
      { selectedIds: selectedIds.filter((s) => !idSet.has(s)) },
    );
  },

  duplicateElements: (ids) => {
    const { document, activePageId } = get();
    if (!document || ids.length === 0) return;
    const page = activePageOf(document, activePageId);
    if (!page) return;
    const idSet = new Set(ids);
    const copies: DesignElement[] = [];
    const elements = page.elements.flatMap((el) => {
      if (!idSet.has(el.id)) return [el];
      const copy = {
        ...el,
        id: newId("el"),
        name: `${el.name} copy`,
        x: el.x + 16,
        y: el.y + 16,
      } as DesignElement;
      copies.push(copy);
      return [el, copy];
    });
    if (copies.length === 0) return;
    commit(set, get, (doc) => withPage(doc, page.id, (p) => ({ ...p, elements })), {
      selectedIds: copies.map((c) => c.id),
    });
  },

  moveElement: (id, dir) => {
    const { document, activePageId } = get();
    if (!document) return;
    const page = activePageOf(document, activePageId);
    if (!page) return;
    const idx = page.elements.findIndex((e) => e.id === id);
    if (idx === -1) return;
    commit(set, get, (doc) =>
      withPage(doc, page.id, (p) => {
        const els = [...p.elements];
        const [el] = els.splice(idx, 1);
        let insertAt: number;
        switch (dir) {
          case "front":
            insertAt = els.length;
            break;
          case "back":
            insertAt = 0;
            break;
          case "forward":
            insertAt = Math.min(idx + 1, els.length);
            break;
          case "backward":
            insertAt = Math.max(idx - 1, 0);
            break;
        }
        els.splice(insertAt, 0, el!);
        return { ...p, elements: els };
      }),
    );
  },

  alignElements: (ids, edge) => {
    const { document, activePageId } = get();
    if (!document || ids.length < 2) return;
    const page = activePageOf(document, activePageId);
    if (!page) return;
    const idSet = new Set(ids);
    const targets = page.elements.filter((e) => idSet.has(e.id));
    if (targets.length < 2) return;
    const boxes = targets.map((el) => ({ el, b: boundsOf(el) }));
    const minX = Math.min(...boxes.map(({ b }) => b.x));
    const maxX = Math.max(...boxes.map(({ b }) => b.x + b.w));
    const minY = Math.min(...boxes.map(({ b }) => b.y));
    const maxY = Math.max(...boxes.map(({ b }) => b.y + b.h));
    const shift = new Map<string, { dx: number; dy: number }>();
    for (const { el, b } of boxes) {
      let dx = 0;
      let dy = 0;
      switch (edge) {
        case "left":
          dx = minX - b.x;
          break;
        case "center-x":
          dx = (minX + maxX) / 2 - (b.x + b.w / 2);
          break;
        case "right":
          dx = maxX - (b.x + b.w);
          break;
        case "top":
          dy = minY - b.y;
          break;
        case "center-y":
          dy = (minY + maxY) / 2 - (b.y + b.h / 2);
          break;
        case "bottom":
          dy = maxY - (b.y + b.h);
          break;
      }
      shift.set(el.id, { dx, dy });
    }
    commit(set, get, (doc) =>
      withPage(doc, page.id, (p) => ({
        ...p,
        elements: p.elements.map((e) => {
          const s = shift.get(e.id);
          if (!s) return e;
          return { ...e, x: e.x + s.dx, y: e.y + s.dy } as DesignElement;
        }),
      })),
    );
  },

  // ── Selection & zoom (no history) ──────────────────────────────────
  select: (ids, additive = false) => {
    const { selectedIds } = get();
    if (additive) {
      const merged = [...selectedIds];
      for (const id of ids) if (!merged.includes(id)) merged.push(id);
      set({ selectedIds: merged });
    } else {
      set({ selectedIds: [...ids] });
    }
  },

  clearSelection: () => set({ selectedIds: [] }),

  setZoom: (z) => {
    set({ zoom: Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z)) });
  },

  // ── History ────────────────────────────────────────────────────────
  undo: () => {
    const { document, past, future, activePageId } = get();
    if (!document || past.length === 0) return;
    const prev = past[past.length - 1]!;
    const stillThere = prev.pages.some((p) => p.id === activePageId);
    set({
      document: prev,
      past: past.slice(0, -1),
      future: [document, ...future],
      dirty: true,
      activePageId: stillThere ? activePageId : (prev.pages[0]?.id ?? null),
      selectedIds: [],
    });
  },

  redo: () => {
    const { document, past, future, activePageId } = get();
    if (!document || future.length === 0) return;
    const next = future[0]!;
    const stillThere = next.pages.some((p) => p.id === activePageId);
    set({
      document: next,
      past: [...past, document],
      future: future.slice(1),
      dirty: true,
      activePageId: stillThere ? activePageId : (next.pages[0]?.id ?? null),
      selectedIds: [],
    });
  },

  canUndo: () => get().past.length > 0,
  canRedo: () => get().future.length > 0,

  markClean: () => set({ dirty: false }),
}));

/**
 * Alias for the editor UI's import convention — same store, both names work.
 * (Sibling editor files import `useCanvasStore` from this module.)
 */
export const useCanvasStore = useDesignStore;
