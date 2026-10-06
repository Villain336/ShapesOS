"use client";

// ShapesOS — Phase 19A (WS=server): publishes the page's cursor targets.
// window.__shapesUiMap() returns every VISIBLE element that carries
// data-cursor-id (lib/cursor/registry.ts), with its rect in CSS px relative
// to the viewport. ShapesOS Desktop's preload calls it and converts the
// rects to screen coordinates with the window bounds and scale factor, so
// the cursor can point at exact elements instead of guessing pixels.
// Renders nothing; reads the DOM only when called.

import { useEffect } from "react";
import { collectUiMap } from "@/lib/cursor/ui-map";

declare global {
  interface Window {
    __shapesUiMap?: () => ReturnType<typeof collectUiMap>;
  }
}

export function CursorUiMap() {
  useEffect(() => {
    const fn = () => collectUiMap(document, window);
    window.__shapesUiMap = fn;
    return () => {
      if (window.__shapesUiMap === fn) delete window.__shapesUiMap;
    };
  }, []);
  return null;
}

export default CursorUiMap;
