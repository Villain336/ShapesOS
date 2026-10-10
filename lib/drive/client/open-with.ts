// ShapesOS — Phase 21B (WS=drive): the "Open with" registry — a SEAM. File-type handlers register here
// and the Files app offers them in the row menu and Quick Look. Today it holds the built-ins the Files app
// registers itself (preview, details, download); apps register theirs through the app platform (21C).
// An app handler only ever receives the one file the person picked (a handle: lib/drive/handles.ts).

import type { Row } from "./rows";

export interface OpenWithHandler {
  id: string;
  /** Already-translated label. */
  label: string;
  /** Which app registered it (21C); built-ins leave it unset. */
  appId?: string;
  /** Lower first. Built-ins sit at 0..9. */
  order?: number;
  accepts(row: Row): boolean;
  open(row: Row): void | Promise<void>;
}

const handlers = new Map<string, OpenWithHandler>();

/** Add (or replace, by id) a handler. Returns a function that removes it. */
export function registerOpenWith(h: OpenWithHandler): () => void {
  handlers.set(h.id, h);
  return () => {
    if (handlers.get(h.id) === h) handlers.delete(h.id);
  };
}

/** The handlers that accept this row, in order. Folders are never offered to file handlers unless they say so. */
export function openWithFor(row: Row): OpenWithHandler[] {
  return [...handlers.values()].filter((h) => h.accepts(row)).sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.label.localeCompare(b.label));
}

export function clearOpenWithForTests(): void {
  handlers.clear();
}
