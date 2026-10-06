// ShapesOS — Phase 18.3 (WS=flow): the browser side of offline mode.
//
//   sendSafeWrite()     one of the few safe writes (OFFLINE_WRITES: create a
//                       note, create a reminder, mark notifications read):
//                       sent now when online; queued with a client id when
//                       the network is down (the server dedupes on it, so a
//                       replay never writes twice). Any other write is never
//                       queued — callers say "you're offline" instead.
//   replayAppQueue()    sends the queue once, oldest first (one tab at a time
//                       via the Web Locks API where the browser has it).
//   forgetOfflineData() sign-out: drop the queue, tell the service worker to
//                       delete this person's read cache, and stop Web Push to
//                       this browser.
//   ensureOwner()       a different person on this browser never replays the
//                       last person's queued writes.

import { classifySend, clearQueue, enqueue, newClientId, OFFLINE_WRITES, readQueue, replayQueue, type KeyValueStore, type OfflineWriteKind, type ReplayReport } from "./queue";

export const APP_QUEUE = "app";
const OWNER_KEY = "shapes_offline_owner";
/** Fired on window whenever the app queue changes (detail: { count }). */
export const OFFLINE_QUEUE_EVENT = "shapes:offline-queue";

export function browserStore(): KeyValueStore | null {
  try {
    const s = window.localStorage;
    const probe = "__shapes_probe";
    s.setItem(probe, "1");
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

function announce(store: KeyValueStore): void {
  try {
    window.dispatchEvent(new CustomEvent(OFFLINE_QUEUE_EVENT, { detail: { count: readQueue(store, APP_QUEUE).length } }));
  } catch {
    // no window (tests)
  }
}

export function queuedCount(): number {
  const s = browserStore();
  return s ? readQueue(s, APP_QUEUE).length : 0;
}

export type SafeWriteOutcome =
  | { status: "sent"; data: Record<string, unknown> }
  | { status: "queued"; clientId: string }
  | { status: "error"; error: string; httpStatus: number | null };

/** Send a safe write now, or queue it when the network is down. */
export async function sendSafeWrite(kind: OfflineWriteKind, body: Record<string, unknown>): Promise<SafeWriteOutcome> {
  const def = OFFLINE_WRITES[kind];
  const clientId = newClientId(kind === "note_create" ? "n" : kind === "reminder_create" ? "r" : "m");
  // Notes and reminders key the write on the client id; mark-read is idempotent by nature.
  const payload = def.idField === null ? body : { ...body, clientId };
  const queue = (): SafeWriteOutcome => {
    const store = browserStore();
    if (!store) return { status: "error", error: "offline", httpStatus: null };
    enqueue(store, APP_QUEUE, { clientId, kind, method: def.method, url: def.url, body: payload });
    announce(store);
    return { status: "queued", clientId };
  };
  if (typeof navigator !== "undefined" && navigator.onLine === false) return queue();
  let res: Response;
  try {
    res = await fetch(def.url, { method: def.method, headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  } catch {
    return queue();
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) return { status: "error", error: typeof data.error === "string" ? data.error : `HTTP ${res.status}`, httpStatus: res.status };
  return { status: "sent", data };
}

let replaying: Promise<ReplayReport | null> | null = null;

/** Replay the app queue once (no-op when empty or already running). */
export function replayAppQueue(): Promise<ReplayReport | null> {
  if (replaying) return replaying;
  const store = browserStore();
  if (!store || readQueue(store, APP_QUEUE).length === 0) return Promise.resolve(null);
  const run = async (): Promise<ReplayReport | null> => {
    const report = await replayQueue(store, APP_QUEUE, async (w) => {
      const def = OFFLINE_WRITES[w.kind as OfflineWriteKind];
      try {
        const res = await fetch(w.url, { method: w.method, headers: { "content-type": "application/json" }, body: JSON.stringify(w.body) });
        const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
        return classifySend(res.status, data, def ? def.idField : "id");
      } catch {
        return classifySend(null, null);
      }
    });
    announce(store);
    return report;
  };
  const locks = (navigator as Navigator & { locks?: { request<T>(name: string, cb: () => Promise<T>): Promise<T> } }).locks;
  replaying = (locks ? locks.request("shapes-offline-replay", run) : run()).finally(() => {
    replaying = null;
  });
  return replaying;
}

/** A different person on this browser: their predecessor's queue is dropped, never replayed. */
export function ensureOwner(userKey: string): void {
  const store = browserStore();
  if (!store) return;
  const prev = store.getItem(OWNER_KEY);
  if (prev !== userKey) {
    clearQueue(store, APP_QUEUE);
    store.setItem(OWNER_KEY, userKey);
  }
}

/** Sign-out: forget this person's offline data and stop Web Push to this browser. */
export async function forgetOfflineData(): Promise<void> {
  const store = browserStore();
  if (store) {
    clearQueue(store, APP_QUEUE);
    try {
      (store as Storage).removeItem?.(OWNER_KEY);
    } catch {
      // ignore
    }
  }
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    reg?.active?.postMessage({ type: "signout" });
    const sub = await reg?.pushManager?.getSubscription();
    if (sub) {
      await fetch("/api/push/web", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => undefined);
      await sub.unsubscribe().catch(() => undefined);
    }
  } catch {
    // best effort: the worker also purges on the sign-out request itself
  }
}
