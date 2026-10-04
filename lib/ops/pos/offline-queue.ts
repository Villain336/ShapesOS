// ShapesOS — Phase 12 (mfgpos): the till's offline queue (client side).
//
// A sale the server didn't acknowledge (network down, server unreachable)
// stays in a queue in the browser's storage and is replayed, oldest first,
// when the connection returns. Every sale carries a client order id that the
// server keys the order on (unique per workspace), so replaying a sale that
// DID land — the response was lost — returns the original order instead of
// selling twice. PURE apart from the injected storage, so it is unit-tested.
//
// Card sales are never queued: a card payment needs the reader online.

export interface QueuedSale {
  clientOrderId: string;
  sessionId: string;
  /** The POST body for /api/ops/pos/sessions/{sessionId}/sales. */
  body: Record<string, unknown>;
  queuedAt: string;
  attempts: number;
  lastError?: string;
}

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type SendResult =
  | { ok: true; replayed: boolean; orderId: string }
  /** The server answered and refused (4xx): retrying the same body won't help. */
  | { ok: false; permanent: true; error: string }
  /** Network / 5xx: keep it queued. */
  | { ok: false; permanent: false; error: string };

export function queueKey(sessionId: string): string {
  return `shapes_pos_queue_${sessionId.replace(/[^A-Za-z0-9_-]/g, "")}`;
}

export function readQueue(store: KeyValueStore, sessionId: string): QueuedSale[] {
  try {
    const raw = store.getItem(queueKey(sessionId));
    const v = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(v) ? (v as QueuedSale[]) : [];
  } catch {
    return [];
  }
}

function writeQueue(store: KeyValueStore, sessionId: string, q: QueuedSale[]): void {
  store.setItem(queueKey(sessionId), JSON.stringify(q));
}

/** Add a sale (a second enqueue of the same client order id is ignored). */
export function enqueue(store: KeyValueStore, sale: Omit<QueuedSale, "queuedAt" | "attempts">, now: Date = new Date()): QueuedSale[] {
  const q = readQueue(store, sale.sessionId);
  if (q.some((s) => s.clientOrderId === sale.clientOrderId)) return q;
  const next = [...q, { ...sale, queuedAt: now.toISOString(), attempts: 0 }];
  writeQueue(store, sale.sessionId, next);
  return next;
}

export interface ReplayReport {
  sent: Array<{ clientOrderId: string; orderId: string; replayed: boolean }>;
  failed: Array<{ clientOrderId: string; error: string }>;
  remaining: number;
}

/**
 * Replay the queue in order. Acknowledged sales (new or replayed) leave the
 * queue; a permanent refusal leaves it too (reported, so the cashier can
 * redo it); a network failure stops the replay and keeps the rest queued.
 */
export async function replayQueue(
  store: KeyValueStore,
  sessionId: string,
  send: (sale: QueuedSale) => Promise<SendResult>,
): Promise<ReplayReport> {
  const report: ReplayReport = { sent: [], failed: [], remaining: 0 };
  let q = readQueue(store, sessionId);
  while (q.length > 0) {
    const head = q[0]!;
    const r = await send(head);
    if (r.ok) {
      report.sent.push({ clientOrderId: head.clientOrderId, orderId: r.orderId, replayed: r.replayed });
      q = q.slice(1);
    } else if (r.permanent) {
      report.failed.push({ clientOrderId: head.clientOrderId, error: r.error });
      q = q.slice(1);
    } else {
      q = [{ ...head, attempts: head.attempts + 1, lastError: r.error }, ...q.slice(1)];
      break;
    }
    writeQueue(store, sessionId, q);
  }
  writeQueue(store, sessionId, q);
  report.remaining = q.length;
  return report;
}

/** Classify a fetch outcome for the queue. */
export function classifySend(status: number | null, data: Record<string, unknown> | null): SendResult {
  if (status !== null && status >= 200 && status < 300 && data && typeof data.orderId === "string") {
    return { ok: true, replayed: data.replayed === true, orderId: data.orderId };
  }
  const error = (data && typeof data.error === "string" ? data.error : null) ?? (status === null ? "No connection" : `Server error ${status}`);
  if (status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429) return { ok: false, permanent: true, error };
  return { ok: false, permanent: false, error };
}
