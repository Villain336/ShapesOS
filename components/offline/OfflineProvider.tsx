"use client";

// ShapesOS — Phase 18.3 (WS=flow): offline mode in the dashboard shell.
//
//   - registers the service worker (public/sw.js; ?dev=1 in development so
//     it never caches dev chunks) and tells it who is signed in (a hash of
//     the subject — the read cache is per person), the offline page's
//     strings in this person's language and the live colour tokens;
//   - keeps the read cache warm: at most every 15 minutes it reads the
//     Home / Mail / Calendar / Notes / Reminders / Files lists once;
//   - replays the queued safe writes when the connection returns (once,
//     keyed on their client ids) and says how many went through;
//   - while offline, a small status pill says what still works.
// A different person on this browser never replays the last one's queue.

import { useEffect, useRef, useState } from "react";
import { CloudOff } from "lucide-react";
import { useI18n } from "@/components/i18n/I18nProvider";
import { toast } from "@/lib/ui/feedback";
import { ensureOwner, OFFLINE_QUEUE_EVENT, queuedCount, replayAppQueue } from "@/lib/offline/client";
import { notifyNotesChanged } from "@/components/notes/events";

const PRIME_KEY = "shapes_offline_primed_at";
const PRIME_EVERY_MS = 15 * 60_000;
const PRIME_URLS = ["/api/notes?", "/api/comms/reminders", "/api/comms/mail/threads", "/api/comms/calendar/events", "/api/files", "/api/desk/layout"];
const TOKEN_NAMES = ["--aos-canvas", "--aos-paper", "--aos-ink", "--aos-muted", "--aos-line", "--aos-control", "--aos-focus", "--aos-hover-paper"];

function liveTokens(): Record<string, string> {
  const cs = getComputedStyle(document.documentElement);
  const out: Record<string, string> = {};
  for (const n of TOKEN_NAMES) {
    const v = cs.getPropertyValue(n).trim();
    if (v) out[n] = v;
  }
  return out;
}

async function prime(): Promise<void> {
  try {
    const last = Number(localStorage.getItem(PRIME_KEY) ?? 0);
    if (Date.now() - last < PRIME_EVERY_MS) return;
    localStorage.setItem(PRIME_KEY, String(Date.now()));
  } catch {
    return;
  }
  for (const url of PRIME_URLS) {
    await fetch(url, { cache: "no-store", priority: "low" } as RequestInit).catch(() => undefined);
  }
}

export function OfflineProvider({ userKey }: { userKey: string }) {
  const { t, locale, messages } = useI18n();
  const queuedTemplate = messages.flow.offline.page.queued;
  const [offline, setOffline] = useState(false);
  const [queued, setQueued] = useState(0);
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => {
    ensureOwner(userKey);
    setQueued(queuedCount());
    setOffline(typeof navigator !== "undefined" && navigator.onLine === false);
    if (!("serviceWorker" in navigator)) return;
    let cancelled = false;
    const dev = process.env.NODE_ENV !== "production";
    navigator.serviceWorker
      .register(dev ? "/sw.js?dev=1" : "/sw.js", { scope: "/", updateViaCache: "none" })
      .then(() => navigator.serviceWorker.ready)
      .then((reg) => {
        if (cancelled) return;
        const tt = tRef.current;
        const strings = {
          lang: locale,
          title: tt("flow.offline.page.title"),
          subtitle: tt("flow.offline.page.subtitle"),
          retry: tt("flow.offline.page.retry"),
          composeTitle: tt("flow.offline.page.composeTitle"),
          noteLabel: tt("flow.offline.page.noteLabel"),
          saveNote: tt("flow.offline.page.saveNote"),
          saveReminder: tt("flow.offline.page.saveReminder"),
          // offline.js fills {count} itself.
          queued: queuedTemplate,
          savedNote: tt("flow.offline.page.savedNote"),
          empty: tt("flow.offline.page.empty"),
          backOnline: tt("flow.offline.page.backOnline"),
          openApp: tt("flow.offline.page.openApp"),
          noSession: tt("flow.offline.page.noSession"),
          write: tt("flow.offline.page.write"),
          sections: {
            home: tt("flow.offline.page.sections.home"),
            mail: tt("flow.offline.page.sections.mail"),
            calendar: tt("flow.offline.page.sections.calendar"),
            notes: tt("flow.offline.page.sections.notes"),
            reminders: tt("flow.offline.page.sections.reminders"),
            files: tt("flow.offline.page.sections.files"),
          },
        };
        reg.active?.postMessage({ type: "session", key: userKey, strings, tokens: liveTokens() });
        void prime();
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [userKey, locale, queuedTemplate]);

  useEffect(() => {
    const sync = async () => {
      const report = await replayAppQueue().catch(() => null);
      setQueued(queuedCount());
      if (!report) return;
      if (report.sent.length) {
        toast({ title: tRef.current("flow.offline.synced", { count: report.sent.length }), status: "done" });
        notifyNotesChanged();
      }
      if (report.failed.length) toast({ title: tRef.current("flow.offline.syncFailed", { count: report.failed.length }), description: report.failed[0]?.error, status: "failed" });
    };
    const goOnline = () => {
      setOffline(false);
      void sync();
    };
    const goOffline = () => setOffline(true);
    const onQueue = (e: Event) => setQueued((e as CustomEvent<{ count: number }>).detail?.count ?? queuedCount());
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    window.addEventListener(OFFLINE_QUEUE_EVENT, onQueue);
    if (navigator.onLine !== false) void sync();
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
      window.removeEventListener(OFFLINE_QUEUE_EVENT, onQueue);
    };
  }, []);

  if (!offline && queued === 0) return null;
  return (
    <div role="status" aria-live="polite" className="pointer-events-none fixed bottom-4 left-4 z-40 flex max-w-[calc(100vw-2rem)] items-center gap-2 rounded-full aos-night px-4 py-2 text-sm font-semibold text-paper shadow-toast">
      <CloudOff className="size-4 shrink-0" aria-hidden />
      <span className="truncate">{offline ? (queued ? t("flow.offline.pillQueued", { count: queued }) : t("flow.offline.pill")) : t("flow.offline.pillSyncing", { count: queued })}</span>
    </div>
  );
}

export default OfflineProvider;
