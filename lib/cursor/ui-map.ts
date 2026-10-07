// ShapesOS — Phase 19A (WS=server): read the page's cursor targets (DOM
// only, no React; unit-testable with a tiny fake document).

export interface UiMapItem {
  id: string;
  label: string;
  role: string;
  rect: { x: number; y: number; w: number; h: number };
}

export const MAX_UI_MAP_ITEMS = 400;

interface ElLike {
  getAttribute(name: string): string | null;
  getBoundingClientRect(): { x?: number; y?: number; left: number; top: number; width: number; height: number };
  closest?(sel: string): unknown;
}

interface DocLike {
  querySelectorAll(sel: string): ArrayLike<ElLike> & Iterable<ElLike>;
}

interface WinLike {
  innerWidth: number;
  innerHeight: number;
  getComputedStyle?(el: never): { visibility: string; display: string; opacity: string };
}

/** Visible [data-cursor-id] elements, first occurrence of each id, in page order. */
export function collectUiMap(doc: DocLike, win: WinLike): UiMapItem[] {
  const out: UiMapItem[] = [];
  const seen = new Set<string>();
  for (const el of Array.from(doc.querySelectorAll("[data-cursor-id]"))) {
    if (out.length >= MAX_UI_MAP_ITEMS) break;
    const id = el.getAttribute("data-cursor-id");
    if (!id || seen.has(id)) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    // Inside the viewport (at least partly).
    if (r.left + r.width <= 0 || r.top + r.height <= 0 || r.left >= win.innerWidth || r.top >= win.innerHeight) continue;
    if (el.closest?.("[aria-hidden='true'],[inert],[hidden]")) continue;
    const cs = win.getComputedStyle?.(el as never);
    if (cs && (cs.visibility === "hidden" || cs.display === "none" || cs.opacity === "0")) continue;
    seen.add(id);
    out.push({
      id,
      label: el.getAttribute("data-cursor-label") ?? "",
      role: el.getAttribute("data-cursor-role") ?? "button",
      rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
    });
  }
  return out;
}
