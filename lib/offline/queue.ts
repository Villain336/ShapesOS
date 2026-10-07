// ShapesOS — Phase 18.3 (WS=flow): the offline write queue (client side),
// generalised from the POS till's queue (lib/ops/pos/offline-queue.ts, which
// is now a thin adapter over this file).
//
// A write the server didn't acknowledge (network down, server unreachable)
// stays in a queue in the browser's storage and is replayed, oldest first,
// when the connection returns. Every write carries a CLIENT id that the
// server keys it on, so replaying a write that DID land (the response was
// lost) returns the original instead of writing twice. PURE apart from the
// injected storage, so it is unit-tested.
//
// Only SAFE writes are ever queued (OFFLINE_WRITES): create a note, create a
// reminder, mark notifications read — each idempotent on its client id at
// the server. Everything else says "you're offline" and does nothing.

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface QueuedWrite<B = Record<string, unknown>> {
  /** Unique per write; the server's idempotency key. */
  clientId: string;
  /** What kind of write (OFFLINE_WRITES key, or a feature's own kind like "pos_sale"). */
  kind: string;
  method: "POST" | "PATCH" | "PUT";
  url: string;
  body: B;
  queuedAt: string;
  attempts: number;
  lastError?: string;
}

export type SendResult =
  | { ok: true; replayed: boolean; id: string }
  /** The server answered and refused (4xx): retrying the same body won't help. */
  | { ok: false; permanent: true; error: string }
  /** Network / 5xx / 408 / 429: keep it queued. */
  | { ok: false; permanent: false; error: string };

export interface ReplayReport {
  sent: Array<{ clientId: string; id: string; replayed: boolean }>;
  failed: Array<{ clientId: string; error: string }>;
  remaining: number;
}

/** The safe writes the app queues while offline (and only these). */
export const OFFLINE_WRITES = {
  note_create: { method: "POST", url: "/api/notes", idField: "note.id" },
  reminder_create: { method: "POST", url: "/api/comms/reminders", idField: "reminder.id" },
  notifications_read: { method: "POST", url: "/api/notifications/read", idField: null },
} as const;

export type OfflineWriteKind = keyof typeof OFFLINE_WRITES;

export function isOfflineWriteKind(v: unknown): v is OfflineWriteKind {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(OFFLINE_WRITES, v);
}

/** Storage key for one named queue ("app" for the shell's queue). */
export function storageKey(queue: string): string {
  return `shapes_offline_queue_${queue.replace(/[^A-Za-z0-9_-]/g, "")}`;
}

/**
 * The generic queue over any item type: `key` is the storage key, `idOf` the
 * item's client id. The app's queue (QueuedWrite) and the POS till's sale
 * queue (lib/ops/pos/offline-queue.ts, its own storage key and item shape so
 * sales already queued in a browser survive the upgrade) both use it.
 */
export interface GenericQueue<T> {
  read(store: KeyValueStore): T[];
  /** Add an item (a second enqueue of the same client id is ignored). */
  enqueue(store: KeyValueStore, item: T): T[];
  clear(store: KeyValueStore): void;
  /**
   * Replay in order. Acknowledged items (new or replayed) leave the queue; a
   * permanent refusal leaves it too (reported, so the person can redo it); a
   * network failure stops the replay and keeps the rest queued. Items
   * enqueued while a send is in flight are kept.
   */
  replay(store: KeyValueStore, send: (item: T) => Promise<SendResult>, retried: (item: T, error: string) => T): Promise<ReplayReport>;
}

export function genericQueue<T>(key: string, idOf: (item: T) => string): GenericQueue<T> {
  const read = (store: KeyValueStore): T[] => {
    try {
      const raw = store.getItem(key);
      const v = raw ? (JSON.parse(raw) as unknown) : [];
      return Array.isArray(v) ? (v as T[]) : [];
    } catch {
      return [];
    }
  };
  const write = (store: KeyValueStore, q: T[]) => store.setItem(key, JSON.stringify(q));
  return {
    read,
    enqueue(store, item) {
      const q = read(store);
      if (q.some((w) => idOf(w) === idOf(item))) return q;
      const next = [...q, item];
      write(store, next);
      return next;
    },
    clear(store) {
      write(store, []);
    },
    async replay(store, send, retried) {
      const report: ReplayReport = { sent: [], failed: [], remaining: 0 };
      let q = read(store);
      while (q.length > 0) {
        const head = q[0]!;
        const id = idOf(head);
        const r = await send(head);
        const fresh = read(store).filter((w) => idOf(w) !== id);
        if (r.ok) {
          report.sent.push({ clientId: id, id: r.id, replayed: r.replayed });
          q = fresh;
        } else if (r.permanent) {
          report.failed.push({ clientId: id, error: r.error });
          q = fresh;
        } else {
          q = [retried(head, r.error), ...fresh];
          write(store, q);
          break;
        }
        write(store, q);
      }
      report.remaining = q.length;
      return report;
    },
  };
}

const appQueue = <B>(queue: string) => genericQueue<QueuedWrite<B>>(storageKey(queue), (w) => w.clientId);

export function readQueue<B = Record<string, unknown>>(store: KeyValueStore, queue: string): QueuedWrite<B>[] {
  return appQueue<B>(queue).read(store);
}

/** Add a write (a second enqueue of the same client id is ignored). */
export function enqueue<B = Record<string, unknown>>(
  store: KeyValueStore,
  queue: string,
  write: Omit<QueuedWrite<B>, "queuedAt" | "attempts">,
  now: Date = new Date(),
): QueuedWrite<B>[] {
  return appQueue<B>(queue).enqueue(store, { ...write, queuedAt: now.toISOString(), attempts: 0 });
}

/** Drop everything queued (sign-out: one person's writes never replay as another). */
export function clearQueue(store: KeyValueStore, queue: string): void {
  appQueue(queue).clear(store);
}

/** Replay a queue of app writes (see GenericQueue.replay). */
export async function replayQueue<B = Record<string, unknown>>(
  store: KeyValueStore,
  queue: string,
  send: (w: QueuedWrite<B>) => Promise<SendResult>,
): Promise<ReplayReport> {
  return appQueue<B>(queue).replay(store, send, (w, error) => ({ ...w, attempts: w.attempts + 1, lastError: error }));
}

/**
 * Classify a fetch outcome for the queue. `idField` names the response field
 * carrying the server's id (null = the write has no id, e.g. mark-read).
 */
export function classifySend(status: number | null, data: Record<string, unknown> | null, idField: string | null = "id"): SendResult {
  if (status !== null && status >= 200 && status < 300 && data) {
    const id = idField === null ? "ok" : pickId(data, idField);
    if (id) return { ok: true, replayed: data.replayed === true, id };
  }
  const error = (data && typeof data.error === "string" ? data.error : null) ?? (status === null ? "No connection" : `Server error ${status}`);
  if (status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429) return { ok: false, permanent: true, error };
  return { ok: false, permanent: false, error };
}

/** "id", or a nested "note.id" / "reminder.id". */
function pickId(data: Record<string, unknown>, field: string): string | null {
  let cur: unknown = data;
  for (const part of field.split(".")) {
    if (!cur || typeof cur !== "object") return null;
    cur = (cur as Record<string, unknown>)[part];
  }
  return typeof cur === "string" && cur ? cur : null;
}

/** A client id: random, URL-safe, unique enough to key a write on. */
export function newClientId(prefix = "w"): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  const r = c?.randomUUID ? c.randomUUID().replace(/-/g, "") : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
  return `${prefix}_${r}`.slice(0, 64);
}

/** Server side: is this a client id we accept as an idempotency key? */
export function isClientId(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(v);
}
