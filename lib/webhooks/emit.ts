// ShapesOS — emit an outbound webhook event (Phase 4a).
//
// Called from domain points AFTER their own write commits (lead created /
// updated, invoice paid, approvals, agent runs, notifications). It only
// ENQUEUES: one durable webhook_deliveries row per enabled, subscribed
// endpoint; /api/cron/webhooks (lib/webhooks/dispatch.ts) does the HTTP.
//
// Never throws and never blocks the triggering action: invalid data, a
// workspace without the webhooks entitlement, no endpoints, or a database
// error all resolve to { enqueued: 0 } with a warning in the server log.

import { randomBytes } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { planHasFeature } from "@/lib/billing/entitlements";
import {
  WEBHOOK_API_VERSION,
  WEBHOOK_EVENT_SCHEMAS,
  endpointWants,
  type WebhookEnvelope,
  type WebhookEventData,
  type WebhookEventType,
} from "./events";

export interface EmitInput<T extends WebhookEventType> {
  workspaceId: string;
  type: T;
  data: WebhookEventData<T>;
  /** Idempotency per endpoint: a second emit with the same key is a no-op. */
  dedupKey?: string | null;
  /** Deliver to this endpoint only (test pings). */
  endpointId?: string;
}

export interface EmitResult {
  eventId: string | null;
  enqueued: number;
  deliveryIds: string[];
}

const NONE: EmitResult = { eventId: null, enqueued: 0, deliveryIds: [] };

export function newEventId(): string {
  return `evt_${randomBytes(12).toString("hex")}`;
}

/** The envelope POSTed to endpoints (exported for tests and the OpenAPI example). */
export function buildEnvelope(
  type: WebhookEventType,
  workspaceId: string,
  data: Record<string, unknown>,
  now: Date = new Date(),
  eventId: string = newEventId(),
): WebhookEnvelope {
  return { id: eventId, type, apiVersion: WEBHOOK_API_VERSION, createdAt: now.toISOString(), workspaceId, data };
}

function warn(type: string, err: unknown) {
  console.warn(`[webhooks] ${type} not enqueued:`, err instanceof Error ? err.message : err);
}

export async function emitWebhookEvent<T extends WebhookEventType>(
  input: EmitInput<T>,
  now: Date = new Date(),
): Promise<EmitResult> {
  try {
    if (!input.workspaceId) return NONE;
    const parsed = WEBHOOK_EVENT_SCHEMAS[input.type].safeParse(input.data);
    if (!parsed.success) {
      warn(input.type, `invalid data (${parsed.error.issues[0]?.path.join(".") ?? "?"})`);
      return NONE;
    }
    const data = parsed.data as Record<string, unknown>;
    return await withWorkspaceScope(input.workspaceId, (tx) => enqueueDeliveries(tx, input, data, now));
  } catch (e) {
    warn(input.type, e);
    return NONE;
  }
}

type ScopedTx = Parameters<Parameters<typeof withWorkspaceScope>[1]>[0];

/** One durable delivery row per enabled, subscribed endpoint (in the caller's tx). */
async function enqueueDeliveries<T extends WebhookEventType>(
  tx: ScopedTx,
  input: EmitInput<T>,
  data: Record<string, unknown>,
  now: Date,
): Promise<EmitResult> {
  const endpoints = await tx.webhookEndpoint.findMany({
    where: { workspaceId: input.workspaceId, enabled: true, ...(input.endpointId ? { id: input.endpointId } : {}) },
    select: { id: true, events: true },
  });
  const targets = endpoints.filter((e) => endpointWants(e.events, input.type));
  if (targets.length === 0) return NONE;
  // Entitlement read only once there is something to deliver.
  const ws = await tx.workspace.findUnique({ where: { id: input.workspaceId }, select: { plan: true } });
  if (!planHasFeature(ws?.plan, "webhooks")) return NONE;

  const envelope = buildEnvelope(input.type, input.workspaceId, data, now);
  const rows = await tx.webhookDelivery.createManyAndReturn({
    data: targets.map((e) => ({
      workspaceId: input.workspaceId,
      endpointId: e.id,
      eventId: envelope.id,
      eventType: input.type,
      dedupKey: input.dedupKey ? input.dedupKey.slice(0, 200) : null,
      payload: envelope as unknown as Prisma.InputJsonValue,
      nextAttemptAt: now,
    })),
    skipDuplicates: true,
    select: { id: true },
  });
  return { eventId: envelope.id, enqueued: rows.length, deliveryIds: rows.map((r) => r.id) };
}

/**
 * Phase 11 (conncore): emit INSIDE the caller's workspace-scoped transaction
 * (transactional outbox): the delivery rows commit — or roll back — with the
 * business write, so an event exists exactly when its write does. Never
 * throws; a failure is contained in a SAVEPOINT so it can't poison the
 * caller's transaction (the write still commits, the event is skipped and
 * logged).
 */
export async function emitWebhookEventInTx<T extends WebhookEventType>(
  tx: ScopedTx,
  input: EmitInput<T>,
  now: Date = new Date(),
): Promise<EmitResult> {
  if (!input.workspaceId) return NONE;
  const parsed = WEBHOOK_EVENT_SCHEMAS[input.type].safeParse(input.data);
  if (!parsed.success) {
    warn(input.type, `invalid data (${parsed.error.issues[0]?.path.join(".") ?? "?"})`);
    return NONE;
  }
  try {
    await tx.$executeRawUnsafe("SAVEPOINT shapes_webhook_emit");
  } catch (e) {
    warn(input.type, e);
    return NONE;
  }
  try {
    const out = await enqueueDeliveries(tx, input, parsed.data as Record<string, unknown>, now);
    await tx.$executeRawUnsafe("RELEASE SAVEPOINT shapes_webhook_emit");
    return out;
  } catch (e) {
    await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT shapes_webhook_emit").catch(() => undefined);
    warn(input.type, e);
    return NONE;
  }
}

// ---------------------------------------------------------------------------
// Small adapters so call sites stay one line
// ---------------------------------------------------------------------------

type LeadRow = {
  id: string;
  workspaceId: string;
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  title: string | null;
  stage: string;
  score: number;
  valueCents: number | null;
  source: string;
  pipelineId: string;
  projectId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export function leadEventData(lead: LeadRow, changed?: string[]): WebhookEventData<"lead.created"> {
  return {
    id: lead.id,
    name: lead.name,
    email: lead.email,
    phone: lead.phone,
    company: lead.company,
    title: lead.title,
    stage: lead.stage,
    score: lead.score,
    valueCents: lead.valueCents,
    source: String(lead.source),
    pipelineId: lead.pipelineId,
    projectId: lead.projectId,
    createdAt: lead.createdAt.toISOString(),
    updatedAt: lead.updatedAt.toISOString(),
    ...(changed ? { changed } : {}),
  };
}

/** lead.created — best-effort, never throws. */
export function emitLeadCreated(lead: LeadRow): Promise<EmitResult> {
  return emitWebhookEvent({
    workspaceId: lead.workspaceId,
    type: "lead.created",
    data: leadEventData(lead),
    dedupKey: `lead.created:${lead.id}`,
  });
}

function isoOrNull(v: unknown): string | null {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string" && v) return v;
  return null;
}

/** invoice.paid from an ops_invoices row — best-effort, never throws. */
export function emitInvoicePaid(
  workspaceId: string,
  row: Record<string, unknown>,
  now: Date = new Date(),
): Promise<EmitResult> {
  const id = String(row.id ?? "");
  return emitWebhookEvent({
    workspaceId,
    type: "invoice.paid",
    data: {
      id,
      customerId: typeof row.customerId === "string" ? row.customerId : null,
      totalCents: Number(row.totalCents ?? 0),
      taxCents: Number(row.taxCents ?? 0),
      status: "paid",
      sentAt: isoOrNull(row.sentAt),
      dueAt: isoOrNull(row.dueAt),
      paidAt: isoOrNull(row.updatedAt) ?? now.toISOString(),
    },
    // An invoice is paid once (paid is terminal in the ops status machine).
    dedupKey: `invoice.paid:${id}`,
  });
}

/** lead.updated — best-effort, never throws. */
export function emitLeadUpdated(lead: LeadRow, changed: string[]): Promise<EmitResult> {
  return emitWebhookEvent({ workspaceId: lead.workspaceId, type: "lead.updated", data: leadEventData(lead, changed) });
}
