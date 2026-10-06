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
  NotificationIcon,
  timeAgo,
  type NotificationItem,
} from "@/components/notifications/NotificationIcon";
import { notificationAction, notificationBanners, notificationStatus } from "@/lib/aos/notifications";
import { toast, toastError } from "@/lib/ui/feedback";
// Phase 18.1 (WS=find): the list chrome in the person's language (titles and
// bodies are generated per notification and stay as written).
import { useI18n } from "@/components/i18n/I18nProvider";
import type { Translator } from "@/lib/i18n";

const PAGE = 30;

function when(iso: string, t: Translator): string {
  const age = timeAgo(iso);
  return age === "now" ? t("notifications.justNow") : t("notifications.ago", { age });
}

export default function NotificationsList() {
  const router = useRouter();
  const { t } = useI18n();
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
      if (!res.ok) throw new Error(body.error ?? t("notifications.loadError"));
      return body as { notifications: NotificationItem[]; unread: number };
    },
    [unreadOnly, t],
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
      setLoadError(e instanceof Error ? e.message : t("notifications.loadError"));
    } finally {
      setLoading(false);
    }
  }, [fetchPage, t]);

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
      toastError(t("notifications.couldNotLoadMore"), e instanceof Error ? e.message : undefined);
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
    if (!res.ok) throw new Error(body.error ?? t("notifications.updateError"));
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
      toast({ title: t("notifications.markedRead"), description: t("notifications.markedReadCount", { count }), status: "done" });
    } catch (e) {
      toastError(t("notifications.couldNotMarkAll"), e instanceof Error ? e.message : undefined);
    } finally {
      setBusy(false);
    }
  }

  function dismiss(n: NotificationItem) {
    void markRead({ ids: [n.id] }).catch((e: unknown) =>
      toastError(t("notifications.couldNotMarkOne"), e instanceof Error ? e.message : undefined),
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
        <div className="flex flex-col gap-2.5" aria-label={t("notifications.needsAttention")}>
          {banners.map((b) => (
            <Banner key={b.key} status={b.status} title={b.title} description={b.description} action={b.action} />
          ))}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <FilterPill selected={unreadOnly} onClick={() => setUnreadOnly((v) => !v)}>
          {t("notifications.unreadOnly")}
        </FilterPill>
        <span className="text-md text-muted tabular-nums">{t("notifications.unreadCount", { count: unread })}</span>
        <button
          type="button"
          onClick={() => void markAll()}
          disabled={busy || unread === 0}
          className={aosButton({ variant: "primary", size: "sm", className: "ml-auto" })}
        >
          <CheckCheck size={15} aria-hidden />
          {t("notifications.markAllRead")}
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
          {t("notifications.loadingList")}
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg bg-paper px-6 py-14 text-center shadow-hairline">
          <Bell size={28} className="text-subtle" aria-hidden />
          <h2 className="aos-subheading">{unreadOnly ? t("notifications.caughtUp") : t("notifications.noneYet")}</h2>
          <p className="max-w-[44ch] text-md text-muted">
            {t("notifications.emptyBody")}
          </p>
        </div>
      ) : (
        <>
          {fresh.length ? (
            <section aria-labelledby="new-h" className="flex flex-col gap-3">
              <h2 id="new-h" className="aos-subheading">
                {t("notifications.new")}
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
                        meta={`${t(`notifications.kinds.${n.kind}`)} · ${when(n.createdAt, t)}`}
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
                {t("notifications.earlier")}
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
                            {t(`notifications.kinds.${n.kind}`)} · {when(n.createdAt, t)}
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
          {busy ? t("common.loading") : t("notifications.loadMore")}
        </button>
      ) : null}
    </div>
  );
}
