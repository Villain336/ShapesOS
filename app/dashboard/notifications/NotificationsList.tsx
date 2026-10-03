"use client";

// ShapesOS — notification center list (Phase 3 J). Dense rows, newest
// first, "Unread only" filter, "Mark all read", and "Load more" paging over
// GET /api/notifications (cursor = createdAt of the last row).

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowUpRight, Bell, CheckCheck, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  NOTIFICATION_KIND_LABELS,
  NotificationIcon,
  type NotificationItem,
} from "@/components/notifications/NotificationIcon";

const PAGE = 30;

export default function NotificationsList() {
  const router = useRouter();
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchPage = useCallback(
    async (before: string | null) => {
      const qs = new URLSearchParams({ limit: String(PAGE) });
      if (unreadOnly) qs.set("unread", "1");
      if (before) qs.set("before", before);
      const res = await fetch(`/api/notifications?${qs}`, { cache: "no-store" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Couldn't load notifications.");
      return body as { notifications: NotificationItem[]; unread: number };
    },
    [unreadOnly],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const body = await fetchPage(null);
      setItems(body.notifications);
      setUnread(body.unread);
      setMore(body.notifications.length === PAGE);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load notifications.");
    } finally {
      setLoading(false);
    }
  }, [fetchPage]);

  useEffect(() => {
    void load();
  }, [load]);

  async function loadMore() {
    const last = items[items.length - 1];
    if (!last) return;
    setBusy(true);
    try {
      const body = await fetchPage(last.createdAt);
      setItems((prev) => [...prev, ...body.notifications.filter((n) => !prev.some((p) => p.id === n.id))]);
      setMore(body.notifications.length === PAGE);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load more.");
    } finally {
      setBusy(false);
    }
  }

  async function markRead(payload: { ids: string[] } | { all: true }) {
    const res = await fetch("/api/notifications/read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? "Couldn't update notifications.");
    setUnread(body.unread);
    const now = new Date().toISOString();
    setItems((prev) =>
      unreadOnly && "all" in payload
        ? []
        : prev.map((n) => ("all" in payload || payload.ids.includes(n.id) ? { ...n, readAt: n.readAt ?? now } : n)),
    );
  }

  async function markAll() {
    setBusy(true);
    setError(null);
    try {
      await markRead({ all: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't mark all read.");
    } finally {
      setBusy(false);
    }
  }

  function open(n: NotificationItem) {
    if (!n.readAt) void markRead({ ids: [n.id] }).catch(() => undefined);
    if (n.href) router.push(n.href);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-pressed={unreadOnly}
          onClick={() => setUnreadOnly((v) => !v)}
          className={cn(
            "inline-flex h-chip items-center gap-1.5 rounded-full px-3 text-sm font-semibold aos-press",
            unreadOnly ? "bg-ink text-white" : "bg-paper text-ink shadow-control hover:shadow-outline",
          )}
        >
          Unread only
        </button>
        <span className="text-sm text-muted">{unread} unread</span>
        <button
          type="button"
          onClick={() => void markAll()}
          disabled={busy || unread === 0}
          className="ml-auto inline-flex h-control-sm items-center gap-1.5 rounded-full bg-ink px-4 text-sm font-semibold text-white aos-press disabled:bg-disabled disabled:text-disabled-fg"
        >
          <CheckCheck size={14} />
          Mark all read
        </button>
      </div>

      {error && (
        <div role="alert" className="flex items-center gap-2 rounded-lg border border-failed bg-failed-tint px-3 py-2 text-sm text-failed-text">
          <span className="aos-shape aos-shape--failed" aria-hidden />
          {error}
          <button onClick={() => setError(null)} className="ml-auto" aria-label="Dismiss error">
            <X size={14} />
          </button>
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted">
          <Loader2 size={16} className="aos-spin" />
          Loading notifications…
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg bg-paper px-6 py-12 text-center shadow-hairline">
          <Bell size={28} className="text-subtle" />
          <div className="text-sm font-semibold text-ink">{unreadOnly ? "No unread notifications" : "No notifications yet"}</div>
          <div className="max-w-[360px] text-sm text-muted">
            New approvals, decisions on your requests, alerts and failed agent runs will show up here.
          </div>
        </div>
      ) : (
        <ul className="overflow-hidden rounded-lg bg-paper shadow-hairline">
          {items.map((n) => (
            <li key={n.id} className="border-b border-line last:border-0">
              <button
                type="button"
                onClick={() => open(n)}
                className="flex min-h-11 w-full items-start gap-3 px-4 py-3 text-left hover:bg-hover-paper"
              >
                <NotificationIcon kind={n.kind} />
                <span className="min-w-0 flex-1">
                  <span className={cn("block text-sm text-ink", !n.readAt && "font-semibold")}>{n.title}</span>
                  {n.body && <span className="mt-0.5 block text-sm text-muted">{n.body}</span>}
                  <span className="mt-1 block text-xs text-subtle">
                    {NOTIFICATION_KIND_LABELS[n.kind]} · {new Date(n.createdAt).toLocaleString()}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-2 pt-0.5">
                  {!n.readAt && <span className="size-2 rounded-full bg-ink" aria-label="Unread" />}
                  {n.href && <ArrowUpRight size={15} className="text-subtle" aria-hidden />}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {more && !loading && (
        <button
          type="button"
          onClick={() => void loadMore()}
          disabled={busy}
          className="mx-auto inline-flex h-control-sm items-center gap-1.5 rounded-full bg-paper px-4 text-sm font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper disabled:opacity-60"
        >
          {busy ? <Loader2 size={14} className="aos-spin" /> : null}
          {busy ? "Loading" : "Load more"}
        </button>
      )}
    </div>
  );
}
