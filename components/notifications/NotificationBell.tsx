"use client";

// ShapesOS — Phase 3 (J): header notification bell.
//
// Bell button with the unread count, a dropdown of the latest notifications
// (white, radius-lg, raised shadow; 44px rows) and "Mark all read". Polls
// GET /api/notifications every minute while the tab is visible. Clicking a
// notification marks it read and opens its link.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bell, CheckCheck, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { invalidateShared, sharedJson } from "@/lib/ui/shared-fetch";
import { NotificationIcon, timeAgo, type NotificationItem } from "./NotificationIcon";

const POLL_MS = 60_000;

export function useNotifications(limit = 8) {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      // Shared: the bell is mounted in both the top bar and the mobile nav.
      const res = await sharedJson(`/api/notifications?limit=${limit}`);
      if (!res.ok) return;
      const body = (res.body ?? { notifications: [], unread: 0 }) as { notifications: NotificationItem[]; unread: number };
      setItems(body.notifications ?? []);
      setUnread(Number(body.unread) || 0);
    } catch {
      /* the bell stays quiet on network errors */
    } finally {
      setLoaded(true);
    }
  }, [limit]);

  const markRead = useCallback(async (payload: { ids: string[] } | { all: true }) => {
    const res = await fetch("/api/notifications/read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return;
    // The shared list is now stale for every mounted bell.
    invalidateShared(`/api/notifications?limit=${limit}`);
    const body = (await res.json()) as { unread: number };
    setUnread(Number(body.unread) || 0);
    const now = new Date().toISOString();
    setItems((prev) =>
      prev.map((n) => ("all" in payload || payload.ids.includes(n.id) ? { ...n, readAt: n.readAt ?? now } : n)),
    );
  }, [limit]);

  useEffect(() => {
    void refresh();
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, POLL_MS);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(timer);
    };
  }, [refresh]);

  return { items, unread, loaded, refresh, markRead };
}

export function NotificationBell({ className }: { className?: string }) {
  const { items, unread, loaded, refresh, markRead } = useNotifications(8);
  const [open, setOpen] = useState(false);
  const [marking, setMarking] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  useEffect(() => {
    if (!open) return;
    void refresh();
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, refresh]);

  async function openItem(n: NotificationItem) {
    setOpen(false);
    if (!n.readAt) void markRead({ ids: [n.id] });
    if (n.href) router.push(n.href);
  }

  async function markAll() {
    setMarking(true);
    try {
      await markRead({ all: true });
    } finally {
      setMarking(false);
    }
  }

  const badge = unread > 99 ? "99+" : String(unread);

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        className="relative inline-flex size-10 items-center justify-center rounded-full text-ink transition-[background-color] duration-150 ease-aos hover:bg-hover active:scale-[0.97]"
      >
        <Bell className="size-[18px]" aria-hidden />
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-ink px-1 text-2xs font-semibold tabular-nums text-white ring-2 ring-paper">
            {badge}
          </span>
        )}
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Notifications"
          className="absolute right-0 top-full z-50 mt-2 w-[360px] max-w-[calc(100vw-32px)] overflow-hidden rounded-lg bg-paper shadow-raised"
        >
          <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
            <span className="text-base font-semibold text-ink">Notifications</span>
            <button
              type="button"
              onClick={() => void markAll()}
              disabled={unread === 0 || marking}
              className="inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-sm font-semibold text-ink hover:bg-hover disabled:text-disabled-fg disabled:hover:bg-transparent"
            >
              {marking ? <Loader2 size={14} className="aos-spin" /> : <CheckCheck size={14} />}
              Mark all read
            </button>
          </div>

          <div className="max-h-[420px] overflow-y-auto p-1.5">
            {!loaded ? (
              <div className="flex items-center gap-2 px-3 py-6 text-sm text-muted">
                <Loader2 size={14} className="aos-spin" />
                Loading
              </div>
            ) : items.length === 0 ? (
              <div className="px-3 py-8 text-center text-sm text-muted">
                You're all caught up. Approvals, alerts and failed runs will show up here.
              </div>
            ) : (
              items.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  role="menuitem"
                  onClick={() => void openItem(n)}
                  className="flex min-h-11 w-full items-start gap-3 rounded-sm px-3 py-2 text-left hover:bg-hover"
                >
                  <NotificationIcon kind={n.kind} title={n.title} />
                  <span className="min-w-0 flex-1">
                    <span className={cn("block truncate text-sm text-ink", !n.readAt && "font-semibold")}>
                      {n.title}
                    </span>
                    {n.body && <span className="block truncate text-xs text-muted">{n.body}</span>}
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-1">
                    <span className="text-xs text-subtle">{timeAgo(n.createdAt)}</span>
                    {!n.readAt && <span className="size-2 rounded-full bg-ink" aria-label="Unread" />}
                  </span>
                </button>
              ))
            )}
          </div>

          <div className="border-t border-line p-1.5">
            <Link
              href="/dashboard/notifications"
              onClick={() => setOpen(false)}
              className="flex h-10 items-center justify-center rounded-sm text-sm font-semibold text-ink hover:bg-hover"
            >
              View all notifications
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

export default NotificationBell;
