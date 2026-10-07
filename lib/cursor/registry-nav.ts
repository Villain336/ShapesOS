// ShapesOS — Phase 19A (WS=server): the cursor ids of every nav destination
// (kept apart from lib/cursor/registry.ts so the kit does not import the
// nav config and its icons).

import { allNavItems } from "@/lib/nav/config";
import { navCursorId } from "./registry";

/** Every nav destination's cursor id (the sidebar rows carry them). */
export function navCursorTargets(): Array<{ id: string; href: string; label: string }> {
  const seen = new Set<string>();
  const out: Array<{ id: string; href: string; label: string }> = [];
  for (const item of allNavItems()) {
    if (seen.has(item.href)) continue;
    seen.add(item.href);
    out.push({ id: navCursorId(item.href), href: item.href, label: item.label });
  }
  return out;
}

