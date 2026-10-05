"use client";

// ShapesOS — notification center (Phase 3 J; Agentic OS 4d).
//
// The kit's toast and banner patterns (toasts-and-banners.png):
//   - unread approvals and failed runs roll up into status banners on top,
//     each with exactly one action;
//   - each unread notification is a black toast card led by its status shape
//     (needs you / failed / approved) — or a neutral icon when it is not an
//     agent state — with one action named for what it opens, and a dismiss
//     that marks it read;
//   - read ones follow as quiet rows.
// Paging, "Unread only" and "Mark all read" work as before over
// GET /api/notifications and POST /api/notifications/read.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Bell, CheckCheck, ChevronRight, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Banner, FilterPill, ToastView, aosButton } from "@/components/aos";
import {
  NOTIFICATION_KIND_ICONS,
  NOTIFICATION_KIND_LABELS,
  NotificationIcon,
  timeAgo,
  type NotificationItem,
} from "@/components/notifications/NotificationIcon";
import { notificationAction, notificationBanners, notificationStatus } from "@/lib/aos/notifications";
import { toast, toastError } from "@/lib/ui/feedback";

const PAGE = 30;

function when(iso: string): string {
  const t = timeAgo(iso);
  return t === "now" ? "Just now" : `${t} ago`;
}

export default function NotificationsList() {
  const router = useRouter();
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  // What waits on this member in the inbox (the needs-you banner); null until known.
  const [approvals, setApprovals] = useState<number | null>(null);

  useEffect(() => {
    fetch("/api/approvals/count", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((b: { actionable?: number } | null) => setApprovals(typeof b?.actionable === "number" ? b.actionable : null))
      .catch(() => setApprovals(null));
  }, []);

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
    setLoadError(null);
    try {
      const body = await fetchPage(null);
      setItems(body.notifications);
      setUnread(body.unread);
      setMore(body.notifications.length === PAGE);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Couldn't load notifications.");
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
      toastError("Couldn't load more", e instanceof Error ? e.message : undefined);
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
    try {
      const count = unread;
      await markRead({ all: true });
      toast({ title: "Marked read", description: `${count} ${count === 1 ? "notification" : "notifications"}.`, status: "done" });
    } catch (e) {
      toastError("Couldn't mark all read", e instanceof Error ? e.message : undefined);
    } finally {
      setBusy(false);
    }
  }

  function dismiss(n: NotificationItem) {
    void markRead({ ids: [n.id] }).catch((e: unknown) =>
      toastError("Couldn't mark it read", e instanceof Error ? e.message : undefined),
    );
  }

  function open(n: NotificationItem) {
    if (!n.readAt) void markRead({ ids: [n.id] }).catch(() => undefined);
    if (n.href) router.push(n.href);
  }

  const banners = useMemo(() => notificationBanners(items, { approvals }), [items, approvals]);
  const fresh = items.filter((n) => !n.readAt);
  const earlier = items.filter((n) => n.readAt);

  return (
    <div className="flex flex-col gap-5">
      {banners.length ? (
        <div className="flex flex-col gap-2.5" aria-label="Needs your attention">
          {banners.map((b) => (
            <Banner key={b.key} status={b.status} title={b.title} description={b.description} action={b.action} />
          ))}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <FilterPill selected={unreadOnly} onClick={() => setUnreadOnly((v) => !v)}>
          Unread only
        </FilterPill>
        <span className="text-md text-muted tabular-nums">{unread} unread</span>
        <button
          type="button"
          onClick={() => void markAll()}
          disabled={busy || unread === 0}
          className={aosButton({ variant: "primary", size: "sm", className: "ml-auto" })}
        >
          <CheckCheck size={15} aria-hidden />
          Mark all read
        </button>
      </div>

      {loadError ? (
        <p role="alert" className="flex items-center gap-2 text-md text-failed-text">
          <span className="size-2.5 shrink-0 bg-failed" aria-hidden />
          {loadError}
        </p>
      ) : null}

      {loading ? (
        <div className="flex items-center gap-2 text-md text-muted">
          <Loader2 size={16} className="aos-spin" aria-hidden />
          Loading notifications…
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg bg-paper px-6 py-14 text-center shadow-hairline">
          <Bell size={28} className="text-subtle" aria-hidden />
          <h2 className="aos-subheading">{unreadOnly ? "You're all caught up" : "No notifications yet"}</h2>
          <p className="max-w-[44ch] text-md text-muted">
            Approvals waiting on you, decisions on your requests, alerts and failed agent runs show up here.
          </p>
        </div>
      ) : (
        <>
          {fresh.length ? (
            <section aria-labelledby="new-h" className="flex flex-col gap-3">
              <h2 id="new-h" className="aos-subheading">
                New
              </h2>
              <ul className="grid items-start gap-3 lg:grid-cols-2">
                {fresh.map((n) => {
                  const action = notificationAction(n);
                  return (
                    <li key={n.id}>
                      <ToastView
                        status={notificationStatus(n)}
                        icon={NOTIFICATION_KIND_ICONS[n.kind]}
                        title={n.title}
                        description={n.body ?? undefined}
                        meta={`${NOTIFICATION_KIND_LABELS[n.kind]} · ${when(n.createdAt)}`}
                        action={action ? { label: action.label, onClick: () => open(n) } : null}
                        onDismiss={() => dismiss(n)}
                        className="animate-none"
                      />
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}

          {earlier.length ? (
            <section aria-labelledby="earlier-h" className="flex flex-col gap-3">
              <h2 id="earlier-h" className="aos-subheading">
                Earlier
              </h2>
              <ul className="overflow-hidden rounded-lg bg-paper shadow-hairline">
                {earlier.map((n) => {
                  const action = notificationAction(n);
                  return (
                    <li key={n.id} className="border-b border-line last:border-0">
                      <button
                        type="button"
                        onClick={() => open(n)}
                        disabled={!n.href}
                        className={cn(
                          "flex min-h-11 w-full items-start gap-3 px-4 py-3 text-left",
                          n.href ? "hover:bg-hover-paper" : "cursor-default",
                        )}
                      >
                        <NotificationIcon kind={n.kind} title={n.title} />
                        <span className="min-w-0 flex-1">
                          <span className="block text-base leading-5 font-semibold text-ink">{n.title}</span>
                          {n.body ? <span className="mt-0.5 block text-md text-muted">{n.body}</span> : null}
                          <span className="mt-1 block text-xs text-subtle">
                            {NOTIFICATION_KIND_LABELS[n.kind]} · {when(n.createdAt)}
                          </span>
                        </span>
                        {action ? (
                          <span className="flex shrink-0 items-center gap-1 pt-0.5 text-sm font-semibold text-ink">
                            {action.label}
                            <ChevronRight size={15} className="text-subtle" aria-hidden />
                          </span>
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}
        </>
      )}

      {more && !loading ? (
        <button
          type="button"
          onClick={() => void loadMore()}
          disabled={busy}
          className={aosButton({ variant: "secondary", size: "sm", className: "self-center" })}
        >
          {busy ? <Loader2 size={14} className="aos-spin" aria-hidden /> : null}
          {busy ? "Loading" : "Load more"}
        </button>
      ) : null}
    </div>
  );
}
