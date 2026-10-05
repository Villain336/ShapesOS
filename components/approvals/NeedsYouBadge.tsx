"use client";

// ShapesOS — Phase 3 (J): "needs you" count badge + hook.
//
// Polls GET /api/approvals/count (what this member can decide across every
// approval queue) and renders a small needs-you pill: yellow fill, black
// text, black triangle — the status color never appears without its shape.
// Renders nothing at zero.
//
// Mount it next to the Approvals nav item (components/AppSidebar.tsx is
// owned by the navigation workstream; see docs in the Phase 3 J report):
//
//   import { NeedsYouBadge } from "@/components/approvals/NeedsYouBadge";
//   …
//   <Link href="/dashboard/approvals" …>
//     <Icon className="size-4 shrink-0" />
//     Approvals
//     <NeedsYouBadge className="ml-auto" />
//   </Link>
//
// Any component that decides an approval can call refreshNeedsYouCount()
// so every mounted badge updates immediately instead of on the next poll.

import { useCallback, useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { sharedJson } from "@/lib/ui/shared-fetch";

const REFRESH_EVENT = "shapes:needs-you-refresh";
const DEFAULT_POLL_MS = 60_000;

export interface NeedsYouCount {
  /** Items this member can decide (what the badge shows). */
  actionable: number;
  /** Everything visible to them, decidable or not. */
  total: number;
  loading: boolean;
  refresh: () => void;
}

/** Ask every mounted badge / hook to re-fetch now. */
export function refreshNeedsYouCount() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(REFRESH_EVENT));
}

export function useNeedsYouCount(pollMs: number = DEFAULT_POLL_MS): NeedsYouCount {
  const [state, setState] = useState({ actionable: 0, total: 0, loading: true });

  const refresh = useCallback(async (fresh = false) => {
    try {
      // Shared with every other mounted badge/hook: one request per page,
      // not one per component (the per-user read rate limit counts each).
      const res = await sharedJson("/api/approvals/count", { fresh });
      if (!res.ok) throw new Error(String(res.status));
      const body = (res.body ?? {}) as { actionable?: number; total?: number };
      setState({
        actionable: Number(body.actionable) || 0,
        total: Number(body.total) || 0,
        loading: false,
      });
    } catch {
      setState((s) => ({ ...s, loading: false }));
    }
  }, []);

  useEffect(() => {
    void refresh();
    // An explicit refresh (an approval was just decided) skips the reuse window.
    const onRefresh = () => void refresh(true);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    window.addEventListener(REFRESH_EVENT, onRefresh);
    document.addEventListener("visibilitychange", onVisible);
    const timer = pollMs > 0 ? window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, pollMs) : null;
    return () => {
      window.removeEventListener(REFRESH_EVENT, onRefresh);
      document.removeEventListener("visibilitychange", onVisible);
      if (timer) window.clearInterval(timer);
    };
  }, [refresh, pollMs]);

  return { ...state, refresh: () => void refresh(true) };
}

/** Presentational pill — use this when you already have the number. */
export function NeedsYouPill({ count, className }: { count: number; className?: string }) {
  if (count <= 0) return null;
  const label = count > 99 ? "99+" : String(count);
  return (
    <span
      className={cn(
        "inline-flex h-5 min-w-5 shrink-0 items-center justify-center gap-1 rounded-full bg-needs px-1.5 text-xs font-semibold tabular-nums text-ink",
        className,
      )}
      aria-label={`${count} approval${count === 1 ? "" : "s"} need you`}
      title={`${count} approval${count === 1 ? "" : "s"} need you`}
    >
      <span
        className="aos-shape aos-shape--needs [--aos-shape-size:8px]"
        style={{ color: "inherit" }}
        aria-hidden
      />
      {label}
    </span>
  );
}

/** Self-fetching badge: the number of approvals this member can decide. */
export function NeedsYouBadge({ className, pollMs }: { className?: string; pollMs?: number }) {
  const { actionable } = useNeedsYouCount(pollMs);
  return <NeedsYouPill count={actionable} className={className} />;
}

export default NeedsYouBadge;
