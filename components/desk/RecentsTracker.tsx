"use client";

// ShapesOS — Phase 18.1 (WS=desk): records the member's visits for the dock's
// "Recent" section and the ⌃Tab switcher (POST /api/desk/recents). Mounted
// once in the dashboard layout; renders nothing. The server decides what is
// worth keeping (lib/desktop/recents.ts) and prunes old visits.

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { normalizeRecentHref, recentsBackoffMs, recentsPostDelay } from "@/lib/desktop/recents";
import { notifyDockChanged } from "./useDock";

export function RecentsTracker() {
  const pathname = usePathname();
  const last = useRef<string | null>(null);
  // Pacing (lib/desktop/recents.ts): reporting a visit spends the same write budget as a real save.
  const lastSentAt = useRef<number | null>(null);
  const pausedUntil = useRef<number | null>(null);

  useEffect(() => {
    const href = normalizeRecentHref(pathname);
    if (!href || href === last.current) return;
    const delay = recentsPostDelay({ now: Date.now(), lastSentAt: lastSentAt.current, pausedUntil: pausedUntil.current });
    const timer = window.setTimeout(async () => {
      last.current = href;
      lastSentAt.current = Date.now();
      try {
        const res = await fetch("/api/desk/recents", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ href, title: document.title }),
        });
        // Always read the body: an unread response keeps its HTTP/1.1
        // connection busy, and with a visit on every navigation the browser's
        // six connections per host run out (later requests then queue
        // forever — found by the Phase 18.1 production smoke).
        await res.text().catch(() => "");
        if (res.ok) notifyDockChanged();
        // The server asked us to slow down: stop reporting until it says we may. The visit is
        // dropped, not retried; the next page reports normally once the back-off has passed.
        else if (res.status === 429) pausedUntil.current = Date.now() + recentsBackoffMs(res.headers.get("Retry-After"));
      } catch {
        // a missed visit is harmless
      }
    }, delay);
    return () => window.clearTimeout(timer);
  }, [pathname]);

  return null;
}
