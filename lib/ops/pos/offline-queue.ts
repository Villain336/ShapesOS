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
//
// Phase 18.3 (WS=flow): the queue mechanics now live in lib/offline/queue.ts
// (the app-wide offline queue); this file keeps the till's API, storage key
// and item shape so sales already queued in a browser survive the upgrade.

import { classifySend as classifyWrite, genericQueue, type KeyValueStore } from "@/lib/offline/queue";

export type { KeyValueStore };

export interface QueuedSale {
  clientOrderId: string;
  sessionId: string;
  /** The POST body for /api/ops/pos/sessions/{sessionId}/sales. */
  body: Record<string, unknown>;
  queuedAt: string;
  attempts: number;
  lastError?: string;
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

const saleQueue = (sessionId: string) => genericQueue<QueuedSale>(queueKey(sessionId), (s) => s.clientOrderId);

export function readQueue(store: KeyValueStore, sessionId: string): QueuedSale[] {
  return saleQueue(sessionId).read(store);
}

/** Add a sale (a second enqueue of the same client order id is ignored). */
export function enqueue(store: KeyValueStore, sale: Omit<QueuedSale, "queuedAt" | "attempts">, now: Date = new Date()): QueuedSale[] {
  return saleQueue(sale.sessionId).enqueue(store, { ...sale, queuedAt: now.toISOString(), attempts: 0 });
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
  const r = await saleQueue(sessionId).replay(
    store,
    async (sale) => {
      const res = await send(sale);
      return res.ok ? { ok: true, replayed: res.replayed, id: res.orderId } : res;
    },
    (sale, error) => ({ ...sale, attempts: sale.attempts + 1, lastError: error }),
  );
  return {
    sent: r.sent.map((s) => ({ clientOrderId: s.clientId, orderId: s.id, replayed: s.replayed })),
    failed: r.failed.map((f) => ({ clientOrderId: f.clientId, error: f.error })),
    remaining: r.remaining,
  };
}

/** Classify a fetch outcome for the queue. */
export function classifySend(status: number | null, data: Record<string, unknown> | null): SendResult {
  const r = classifyWrite(status, data, "orderId");
  return r.ok ? { ok: true, replayed: r.replayed, orderId: r.id } : r;
}
