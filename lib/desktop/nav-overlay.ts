// ShapesOS — Phase 18.1 (WS=desk): the dock — pins and their order, as an
// OVERLAY on lib/nav/config.ts (PURE, client-safe).
//
// There is one nav list (NAV_GROUPS). A member's dock only stores which of its
// hrefs they pinned, in their order (user_desktop_layouts.nav = { pinned }).
// Reading it back always goes through the nav config:
//   - an href that is no longer a nav item (renamed, removed) is dropped
//     silently — the dock never shows a dead link;
//   - a role-gated item stays gated: pinning cannot reveal it (navItemVisible);
//   - duplicates collapse to their first position.

import { z } from "zod";
import { NAV_GROUPS, allNavItems, navItemVisible, type NavGroup, type NavItem } from "@/lib/nav/config";

/** At most this many pins (the dock stays a dock, not a second nav). */
export const MAX_PINS = 12;

export interface NavPrefs {
  pinned: string[];
}

export const NavPrefsSchema = z.object({
  pinned: z.array(z.string().trim().min(1).max(200)).max(MAX_PINS * 4),
});

/** Drop unknown hrefs, gated items and duplicates; cap at MAX_PINS. Never throws. */
export function sanitizeNavPrefs(raw: unknown, role: string | null | undefined, groups: NavGroup[] = NAV_GROUPS): NavPrefs {
  // Over-long input is cut to the schema's bound, not thrown away: with the
  // 18.2 apps the nav has more items than MAX_PINS * 4, so "pin everything"
  // must still keep the first MAX_PINS that are visible.
  const capped = raw && typeof raw === "object" && Array.isArray((raw as { pinned?: unknown }).pinned) ? { ...(raw as object), pinned: (raw as { pinned: unknown[] }).pinned.slice(0, MAX_PINS * 4) } : raw;
  const parsed = NavPrefsSchema.safeParse(capped);
  if (!parsed.success) return { pinned: [] };
  const items = new Map(allNavItems(groups).map((i) => [i.href, i]));
  const out: string[] = [];
  for (const href of parsed.data.pinned) {
    const item = items.get(href);
    if (!item || !navItemVisible(item, role) || out.includes(href)) continue;
    out.push(href);
    if (out.length >= MAX_PINS) break;
  }
  return { pinned: out };
}

/** The pinned nav items, in the member's order (already sanitized). */
export function pinnedNavItems(prefs: NavPrefs, role: string | null | undefined, groups: NavGroup[] = NAV_GROUPS): NavItem[] {
  const items = new Map(allNavItems(groups).map((i) => [i.href, i]));
  return sanitizeNavPrefs(prefs, role, groups).pinned.map((h) => items.get(h)!);
}

export function isPinned(prefs: NavPrefs, href: string): boolean {
  return prefs.pinned.includes(href);
}

/** Pin (appended last) or unpin. Pinning past MAX_PINS is a no-op. */
export function togglePin(prefs: NavPrefs, href: string): NavPrefs {
  if (prefs.pinned.includes(href)) return { pinned: prefs.pinned.filter((h) => h !== href) };
  if (prefs.pinned.length >= MAX_PINS) return prefs;
  return { pinned: [...prefs.pinned, href] };
}

/** Move a pin one place up (-1) or down (+1); clamps at the ends. */
export function movePin(prefs: NavPrefs, href: string, dir: -1 | 1): NavPrefs {
  const i = prefs.pinned.indexOf(href);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= prefs.pinned.length) return prefs;
  const next = [...prefs.pinned];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return { pinned: next };
}
