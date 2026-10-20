// ShapesOS — Phase 11 (conncore): outbound webhook events for Phase 9/10
// business entities (Zapier / n8n / Make subscriptions).
//
// opsWebhookEvents() is PURE: given an ops entity write (before → after) it
// says which events happened — invoice sent/paid, quote sent/accepted, deal
// created/stage changed/won/lost, ticket opened/solved, contact created,
// order paid. emitOpsWriteEvents() enqueues them inside the SAME transaction
// as the write (emitWebhookEventInTx: transactional outbox, SAVEPOINT-
// contained, never throws), so one hook covers every path that writes
// through the ops service (lib/ops/doctype.ts opsCreate / opsPatch — the
// generic /api/ops route, agent tools, the portal, recurring invoices…),
// plus the two paths that write directly (invoice payments, Stripe-paid web
// orders) which call it themselves. Each event carries a dedupKey, so a
// retried write or a second path never delivers the same event twice.
// No new delivery system: the Phase 4a queue + cron deliver them.

// Phase 18.3 (WS=trust): notifications at the same seam.
import { opsNotices, queueOpsNotices } from "@/lib/notifications/ops";
import type { WebhookEventData, WebhookEventType } from "./events";
import { emitWebhookEventInTx } from "./emit";

type Row = Record<string, unknown>;

export interface OpsEvent<T extends WebhookEventType = WebhookEventType> {
  type: T;
  data: WebhookEventData<T>;
  dedupKey: string | null;
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const int = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
};
const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : typeof v === "string" && v ? v : null);
const changedTo = (before: Row | null, after: Row, field: string, value: string) =>
  after[field] === value && (!before || before[field] !== value);

function dealData(after: Row, fromStage?: string | null): WebhookEventData<"deal.created"> {
  const status = after.status === "won" || after.status === "lost" ? after.status : "open";
  return {
    id: String(after.id),
    title: String(after.title ?? ""),
    pipelineId: String(after.pipelineId ?? ""),
    stage: String(after.stage ?? ""),
    ...(fromStage !== undefined ? { fromStage } : {}),
    status,
    valueCents: int(after.valueCents),
    contactId: str(after.contactId),
    companyId: str(after.companyId),
    ownerId: str(after.ownerId),
    expectedCloseAt: iso(after.expectedCloseAt),
    closedAt: iso(after.closedAt),
    updatedAt: iso(after.updatedAt) ?? new Date().toISOString(),
  };
}

function ticketData(after: Row): WebhookEventData<"ticket.created"> {
  return {
    id: String(after.id),
    number: after.number === undefined || after.number === null ? null : int(after.number),
    subject: String(after.subject ?? ""),
    status: String(after.status ?? ""),
    priority: String(after.priority ?? "normal"),
    channel: str(after.channel),
    requesterEmail: str(after.requesterEmail),
    contactId: str(after.contactId),
    assigneeId: str(after.assigneeId),
    createdAt: iso(after.createdAt) ?? new Date().toISOString(),
    updatedAt: iso(after.updatedAt) ?? new Date().toISOString(),
  };
}

function quoteData(after: Row): WebhookEventData<"quote.sent"> {
  return {
    id: String(after.id),
    number: str(after.number),
    customerId: str(after.customerId),
    totalCents: int(after.totalCents),
    status: String(after.status ?? ""),
    validUntil: iso(after.validUntil),
  };
}

/** Invoice paid payload (shared with the payments path). PURE. */
export function invoicePaidEvent(after: Row): OpsEvent<"invoice.paid"> {
  const id = String(after.id);
  return {
    type: "invoice.paid",
    data: {
      id,
      customerId: str(after.customerId),
      totalCents: int(after.totalCents),
      taxCents: int(after.taxCents),
      status: "paid",
      sentAt: iso(after.sentAt),
      dueAt: iso(after.dueAt),
      paidAt: iso(after.paidAt) ?? iso(after.updatedAt) ?? new Date().toISOString(),
    },
    // Paid is terminal: once per invoice (same key as the Phase 4a route emit).
    dedupKey: `invoice.paid:${id}`,
  };
}

/** Order paid payload (Stripe-paid web orders). PURE. */
export function orderPaidEvent(after: Row, provider: string | null): OpsEvent<"order.paid"> {
  const id = String(after.id);
  return {
    type: "order.paid",
    data: {
      id,
      source: str(after.source),
      storeId: str(after.storeId),
      customerId: str(after.customerId),
      customerEmail: str(after.customerEmail),
      totalCents: int(after.totalCents),
      taxCents: int(after.taxCents),
      status: String(after.status ?? ""),
      paidAt: iso(after.paidAt) ?? new Date().toISOString(),
      paymentProvider: provider,
    },
    dedupKey: `order.paid:${id}`,
  };
}

/** Which events an ops entity write produced. PURE. */
export function opsWebhookEvents(slug: string, before: Row | null, after: Row): OpsEvent[] {
  if (!after || typeof after.id !== "string") return [];
  const id = after.id;
  const out: OpsEvent[] = [];
  switch (slug) {
    case "invoices": {
      if (after.kind === "credit_note") break;
      if (changedTo(before, after, "status", "sent")) {
        out.push({
          type: "invoice.sent",
          data: {
            id,
            number: str(after.number),
            customerId: str(after.customerId),
            totalCents: int(after.totalCents),
            taxCents: int(after.taxCents),
            status: "sent",
            sentAt: iso(after.sentAt),
            dueAt: iso(after.dueAt),
          },
          dedupKey: `invoice.sent:${id}`,
        });
      }
      if (changedTo(before, after, "status", "paid")) out.push(invoicePaidEvent(after));
      break;
    }
    case "quotes": {
      if (changedTo(before, after, "status", "sent")) out.push({ type: "quote.sent", data: quoteData(after), dedupKey: `quote.sent:${id}` });
      if (changedTo(before, after, "status", "accepted")) out.push({ type: "quote.accepted", data: quoteData(after), dedupKey: `quote.accepted:${id}` });
      break;
    }
    case "deals": {
      if (!before) {
        out.push({ type: "deal.created", data: dealData(after), dedupKey: `deal.created:${id}` });
        break;
      }
      if (before.stage !== after.stage) {
        const from = str(before.stage);
        // A stage change can legitimately repeat (A→B→A→B): no dedup key.
        out.push({ type: "deal.stage_changed", data: dealData(after, from), dedupKey: null });
      }
      if (changedTo(before, after, "status", "won")) out.push({ type: "deal.won", data: dealData(after), dedupKey: `deal.won:${id}:${iso(after.closedAt) ?? ""}` });
      if (changedTo(before, after, "status", "lost")) out.push({ type: "deal.lost", data: dealData(after), dedupKey: `deal.lost:${id}:${iso(after.closedAt) ?? ""}` });
      break;
    }
    case "tickets": {
      if (!before) out.push({ type: "ticket.created", data: ticketData(after), dedupKey: `ticket.created:${id}` });
      else if (changedTo(before, after, "status", "solved")) {
        out.push({ type: "ticket.solved", data: ticketData(after), dedupKey: `ticket.solved:${id}:${iso(after.updatedAt) ?? ""}` });
      }
      break;
    }
    case "contacts": {
      if (!before) {
        out.push({
          type: "contact.created",
          data: {
            id,
            name: String(after.name ?? ""),
            email: str(after.email),
            phone: str(after.phone),
            title: str(after.title),
            companyId: str(after.companyId),
            createdAt: iso(after.createdAt) ?? new Date().toISOString(),
          },
          dedupKey: `contact.created:${id}`,
        });
      }
      break;
    }
  }
  return out;
}

type Tx = Parameters<typeof emitWebhookEventInTx>[0];

/** Enqueue the events of one ops write in its own transaction. Never throws. */
export async function emitOpsWriteEvents(tx: Tx, workspaceId: string, slug: string, before: Row | null, after: Row, actorUserId: string | null = null): Promise<number> {
  let n = 0;
  // Phase 18.3 (WS=trust): invoice paid / ticket assigned notifications,
  // produced right after this write's transaction (lib/notifications/ops.ts).
  try {
    queueOpsNotices(workspaceId, opsNotices(slug, before, after), actorUserId);
  } catch {
    /* pure mapper + setImmediate: nothing to do */
  }
  try {
    for (const ev of opsWebhookEvents(slug, before, after)) {
      n += (await emitWebhookEventInTx(tx, { workspaceId, type: ev.type, data: ev.data as never, dedupKey: ev.dedupKey })).enqueued;
    }
  } catch {
    /* emitWebhookEventInTx never throws; the mapper is pure */
  }
  return n;
}

/** Same, for a ready-made event (payments / web-order paths). Never throws. */
export async function emitOpsEvent(tx: Tx, workspaceId: string, ev: OpsEvent, actorUserId: string | null = null): Promise<number> {
  // Phase 18.3 (WS=trust): a payment that settles an invoice notifies too.
  if (ev.type === "invoice.paid") {
    const d = ev.data as { id: string; totalCents?: number | null };
    queueOpsNotices(workspaceId, [{ kind: "invoice_paid", invoiceId: d.id, number: null, totalCents: d.totalCents ?? null, currency: null }], actorUserId);
  }
  return (await emitWebhookEventInTx(tx, { workspaceId, type: ev.type, data: ev.data as never, dedupKey: ev.dedupKey })).enqueued;
}
