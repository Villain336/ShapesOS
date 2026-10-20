"use client";

// ShapesOS — Phase 18.2 (WS=comms): the Messages unread count for the dock.
// One poller for the whole page however many rows show it (the sidebar, the
// mobile drawer, a pinned copy): it reads /api/comms/messages/unread once a
// minute while something is subscribed, when the window regains focus, and
// at once when the Messages app says the count moved (MESSAGES_UNREAD_EVENT).

import { useSyncExternalStore } from "react";

export const MESSAGES_UNREAD_EVENT = "shapes:messages-unread";
const POLL_MS = 60_000;

let count = 0;
let subscribers = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;
const listeners = new Set<() => void>();

async function refresh() {
  if (inFlight || typeof window === "undefined") return;
  inFlight = true;
  try {
    const res = await fetch("/api/comms/messages/unread", { cache: "no-store" });
    if (res.ok) {
      const j = (await res.json()) as { total?: number };
      const next = Math.max(0, Number(j.total) || 0);
      if (next !== count) {
        count = next;
        for (const l of listeners) l();
      }
    }
  } catch {
    // keep the last count
  } finally {
    inFlight = false;
  }
}

const onSignal = () => void refresh();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  subscribers++;
  if (subscribers === 1) {
    void refresh();
    timer = setInterval(() => void refresh(), POLL_MS);
    window.addEventListener(MESSAGES_UNREAD_EVENT, onSignal);
    window.addEventListener("focus", onSignal);
  }
  return () => {
    listeners.delete(listener);
    subscribers--;
    if (subscribers === 0) {
      if (timer) clearInterval(timer);
      timer = null;
      window.removeEventListener(MESSAGES_UNREAD_EVENT, onSignal);
      window.removeEventListener("focus", onSignal);
    }
  };
}

const noop = () => () => undefined;

/** The member's unread Messages count (0 when `enabled` is false: nothing is fetched). */
export function useMessagesUnread(enabled: boolean): number {
  return useSyncExternalStore(
    enabled ? subscribe : noop,
    () => (enabled ? count : 0),
    () => 0,
  );
}
