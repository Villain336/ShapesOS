"use client";

// ShapesOS — Phase 18.1 (WS=desk): records the member's visits for the dock's
// "Recent" section and the ⌃Tab switcher (POST /api/desk/recents). Mounted
// once in the dashboard layout; renders nothing. The server decides what is
// worth keeping (lib/desktop/recents.ts) and prunes old visits.

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { normalizeRecentHref } from "@/lib/desktop/recents";
import { notifyDockChanged } from "./useDock";

/** Wait for the new page's <title> before reporting the visit. */
const SETTLE_MS = 600;

export function RecentsTracker() {
  const pathname = usePathname();
  const last = useRef<string | null>(null);

  useEffect(() => {
    const href = normalizeRecentHref(pathname);
    if (!href || href === last.current) return;
    const timer = window.setTimeout(async () => {
      last.current = href;
      try {
        const res = await fetch("/api/desk/recents", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ href, title: document.title }),
        });
        if (res.ok) notifyDockChanged();
      } catch {
        // a missed visit is harmless
      }
    }, SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [pathname]);

  return null;
}
