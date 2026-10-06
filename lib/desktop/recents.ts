// ShapesOS — Phase 18.1 (WS=desk): recents (PURE, client-safe).
//
// The dock's "Recent" section and the ⌃Tab app switcher list the last pages
// and records a member opened. The browser reports each visit to
// POST /api/desk/recents; these rules decide what is worth remembering and
// how it is labelled. Storage (user_recent_items, owner-only RLS) lives in
// lib/desktop/recents.server.ts.

import { activeNavHref, allNavItems, type NavItem } from "@/lib/nav/config";

/** Shown in the dock and the switcher. */
export const RECENTS_SHOWN = 8;
/** Kept per member (older visits are pruned on write). */
export const RECENTS_KEEP = 30;

/** Pages that are the shell itself, not somewhere you'd switch back to. */
const NOT_RECENT = ["/dashboard/switch", "/dashboard/split", "/dashboard/welcome"];

export type RecentKind = "app" | "record";

export interface RecentItem {
  href: string;
  title: string;
  kind: RecentKind;
  /** ISO time of the last visit. */
  visitedAt: string;
}

/**
 * The canonical href to remember, or null when the page is not one: only
 * same-app /dashboard paths (no scheme, no "//", no backslashes, no control
 * characters); the query string and hash are dropped (a tab param is not a
 * different place); trailing slashes trimmed.
 */
export function normalizeRecentHref(input: unknown): string | null {
  if (typeof input !== "string") return null;
  let h = input.trim();
  if (!h.startsWith("/dashboard")) return null;
  if (h.startsWith("//") || h.includes("\\") || /[\u0000-\u001f\s]/.test(h)) return null;
  h = h.split(/[?#]/)[0]!;
  if (h.length > 1 && h.endsWith("/")) h = h.replace(/\/+$/, "");
  if (h !== "/dashboard" && !h.startsWith("/dashboard/")) return null;
  if (h.length > 300) return null;
  if (NOT_RECENT.some((p) => h === p || h.startsWith(`${p}/`))) return null;
  return h;
}

/** The nav item that owns an href (for its icon and app name). */
export function appForHref(href: string): NavItem | null {
  const owner = activeNavHref(href);
  return owner ? (allNavItems().find((i) => i.href === owner) ?? null) : null;
}

/** "app" when the href IS a nav destination; "record" for anything below one. */
export function classifyRecent(href: string): RecentKind {
  return allNavItems().some((i) => i.href === href || i.activePrefix === href) ? "app" : "record";
}

const SUFFIX = /\s*[—–|-]\s*(ShapesOS|Marketr)\s*$/i;
/** The product's own (generic) title — a page that never set one. */
const GENERIC = /^(ShapesOS|Marketr)(\s*[—–|-].*)?$/i;

/**
 * A short label. An app (a nav destination) is always called by its nav
 * label — the name the member knows it by. A record uses the page's own
 * <title> without the product suffix; a page with only the generic product
 * title falls back to the app name plus the last path segment.
 */
export function recentTitle(href: string, documentTitle?: unknown): string {
  const raw = typeof documentTitle === "string" ? documentTitle.trim() : "";
  const t = GENERIC.test(raw) ? "" : raw.replace(SUFFIX, "").trim();
  const app = appForHref(href);
  if (app && classifyRecent(href) === "app") return app.label;
  if (t) {
    // A record page often keeps its app's generic title: add the record hint.
    if (app && classifyRecent(href) === "record" && t.toLowerCase() === app.label.toLowerCase()) {
      return `${app.label} · ${lastSegmentLabel(href)}`.slice(0, 120);
    }
    return t.slice(0, 120);
  }
  if (!app) return lastSegmentLabel(href);
  return classifyRecent(href) === "app" ? app.label : `${app.label} · ${lastSegmentLabel(href)}`.slice(0, 120);
}

function lastSegmentLabel(href: string): string {
  const seg = decodeURIComponentSafe(href.split("/").filter(Boolean).pop() ?? "Overview");
  const words = seg.replace(/[-_]+/g, " ").trim();
  // Opaque ids (cuid / uuid / numeric) read as "record <short id>".
  if (/^[a-z0-9]{20,}$/i.test(seg) || /^[0-9a-f-]{32,36}$/i.test(seg) || /^\d+$/.test(seg)) return `record ${seg.slice(0, 8)}`;
  return words ? words[0]!.toUpperCase() + words.slice(1) : "Page";
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
