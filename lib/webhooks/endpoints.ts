// ShapesOS — outbound webhook endpoint management (Phase 4a).
//
// Admin-only (the routes gate the role; this module gates the plan). URLs
// follow the safeFetch rules at save time (https, no credentials, no
// private/loopback/metadata targets — re-checked on every delivery too).
// The signing secret is returned exactly once (create / rotate) and stored
// only as a secrets() envelope. Every table access is workspace-scoped
// (FORCE RLS).

import { z } from "zod";
import type { WebhookDeliveryStatus } from "@prisma/client";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { assertSafeUrl, UnsafeUrlError, type ResolveFn } from "@/lib/safe-url";
import { secrets } from "@/lib/secrets";
import { BadRequestError, NotFoundError } from "@/lib/api/errors";
import { requireEntitlement } from "@/lib/billing/entitlements-server";
import { SUBSCRIBABLE_EVENT_TYPES } from "./events";
import { mintWebhookSecret, secretHint } from "./signing";
import { emitWebhookEvent } from "./emit";
import type { Prisma } from "@prisma/client";

export const MAX_ENDPOINTS_PER_WORKSPACE = 20;

const EventList = z
  .array(z.enum(SUBSCRIBABLE_EVENT_TYPES as [string, ...string[]]))
  .max(SUBSCRIBABLE_EVENT_TYPES.length)
  .transform((a) => [...new Set(a)]);

export const CreateEndpointSchema = z
  .object({
    url: z.string().trim().min(1).max(2048),
    description: z.string().trim().max(200).optional().nullable(),
    /** Empty or omitted = every event. */
    events: EventList.optional().default([]),
  })
  .strict();

export const UpdateEndpointSchema = z
  .object({
    url: z.string().trim().min(1).max(2048).optional(),
    description: z.string().trim().max(200).optional().nullable(),
    events: EventList.optional(),
    enabled: z.boolean().optional(),
    rotateSecret: z.literal(true).optional(),
  })
  .strict();

export type CreateEndpointInput = z.input<typeof CreateEndpointSchema>;
export type UpdateEndpointInput = z.input<typeof UpdateEndpointSchema>;

/** https only, plus every safeFetch rule. Returns the trimmed URL. */
export async function validateEndpointUrl(raw: string, resolve?: ResolveFn): Promise<string> {
  const url = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new BadRequestError("Enter a full URL, like https://example.com/webhooks.");
  }
  if (parsed.protocol !== "https:") throw new BadRequestError("Webhook URLs must use https.");
  try {
    await assertSafeUrl(url, { resolve });
  } catch (e) {
    if (e instanceof UnsafeUrlError) throw new BadRequestError(`That URL can't receive webhooks: ${e.message}`);
    throw e;
  }
  return url;
}

export interface EndpointView {
  id: string;
  url: string;
  description: string | null;
  events: string[];
  enabled: boolean;
  secretHint: string;
  consecutiveFailures: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  createdAt: string;
}

type EndpointRow = {
  id: string;
  url: string;
  description: string | null;
  events: string[];
  enabled: boolean;
  secretHint: string;
  consecutiveFailures: number;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  createdAt: Date;
};

export function toEndpointView(e: EndpointRow): EndpointView {
  return {
    id: e.id,
    url: e.url,
    description: e.description,
    events: e.events,
    enabled: e.enabled,
    secretHint: e.secretHint,
    consecutiveFailures: e.consecutiveFailures,
    lastSuccessAt: e.lastSuccessAt?.toISOString() ?? null,
    lastFailureAt: e.lastFailureAt?.toISOString() ?? null,
    createdAt: e.createdAt.toISOString(),
  };
}

export async function listEndpoints(workspaceId: string): Promise<EndpointView[]> {
  const rows = await withWorkspaceScope(workspaceId, (tx) =>
    tx.webhookEndpoint.findMany({ where: { workspaceId }, orderBy: { createdAt: "asc" } }),
  );
  return rows.map(toEndpointView);
}

export async function createEndpoint(
  workspaceId: string,
  userId: string,
  body: unknown,
  opts: { resolve?: ResolveFn } = {},
): Promise<{ endpoint: EndpointView; secret: string }> {
  await requireEntitlement(workspaceId, "webhooks");
  const input = CreateEndpointSchema.parse(body);
  const url = await validateEndpointUrl(input.url, opts.resolve);
  const secret = mintWebhookSecret();
  const row = await withWorkspaceScope(workspaceId, async (tx) => {
    const count = await tx.webhookEndpoint.count({ where: { workspaceId } });
    if (count >= MAX_ENDPOINTS_PER_WORKSPACE) {
      throw new BadRequestError(`A workspace can have at most ${MAX_ENDPOINTS_PER_WORKSPACE} webhook endpoints.`);
    }
    return tx.webhookEndpoint.create({
      data: {
        workspaceId,
        url,
        description: input.description || null,
        events: input.events,
        secretEnc: secrets().encrypt(secret),
        secretHint: secretHint(secret),
        createdBy: userId,
      },
    });
  });
  return { endpoint: toEndpointView(row), secret };
}

export async function updateEndpoint(
  workspaceId: string,
  id: string,
  body: unknown,
  opts: { resolve?: ResolveFn } = {},
): Promise<{ endpoint: EndpointView; secret: string | null }> {
  const input = UpdateEndpointSchema.parse(body);
  // Turning an endpoint on, or pointing it somewhere new, needs the plan;
  // turning it off or editing its label never does.
  if (input.enabled === true || input.url !== undefined || input.rotateSecret) {
    await requireEntitlement(workspaceId, "webhooks");
  }
  const data: Prisma.WebhookEndpointUpdateInput = {};
  if (input.url !== undefined) data.url = await validateEndpointUrl(input.url, opts.resolve);
  if (input.description !== undefined) data.description = input.description || null;
  if (input.events !== undefined) data.events = input.events;
  if (input.enabled !== undefined) {
    data.enabled = input.enabled;
    if (input.enabled) data.consecutiveFailures = 0;
  }
  let secret: string | null = null;
  if (input.rotateSecret) {
    secret = mintWebhookSecret();
    data.secretEnc = secrets().encrypt(secret);
    data.secretHint = secretHint(secret);
  }
  if (Object.keys(data).length === 0) throw new BadRequestError("Nothing to update.");
  const row = await withWorkspaceScope(workspaceId, async (tx) => {
    const existing = await tx.webhookEndpoint.findFirst({ where: { id, workspaceId }, select: { id: true } });
    if (!existing) throw new NotFoundError("Webhook endpoint not found.");
    return tx.webhookEndpoint.update({ where: { id }, data });
  });
  return { endpoint: toEndpointView(row), secret };
}

export async function deleteEndpoint(workspaceId: string, id: string): Promise<void> {
  await withWorkspaceScope(workspaceId, async (tx) => {
    const res = await tx.webhookEndpoint.deleteMany({ where: { id, workspaceId } });
    if (res.count === 0) throw new NotFoundError("Webhook endpoint not found.");
  });
}

/** Queue a webhook.ping for one endpoint; returns the delivery id. */
export async function queueTestEvent(workspaceId: string, endpointId: string): Promise<string> {
  await requireEntitlement(workspaceId, "webhooks");
  const exists = await withWorkspaceScope(workspaceId, (tx) =>
    tx.webhookEndpoint.findFirst({ where: { id: endpointId, workspaceId }, select: { enabled: true } }),
  );
  if (!exists) throw new NotFoundError("Webhook endpoint not found.");
  if (!exists.enabled) throw new BadRequestError("Turn the endpoint on before sending a test event.");
  const res = await emitWebhookEvent({
    workspaceId,
    type: "webhook.ping",
    data: { message: "Test event from ShapesOS. If you can read this, your endpoint works." },
    endpointId,
  });
  const id = res.deliveryIds[0];
  if (!id) throw new BadRequestError("The test event couldn't be queued.");
  return id;
}

// ---------------------------------------------------------------------------
// Delivery log
// ---------------------------------------------------------------------------

export interface DeliveryView {
  id: string;
  endpointId: string;
  endpointUrl: string | null;
  eventId: string;
  eventType: string;
  status: WebhookDeliveryStatus;
  attempts: number;
  nextAttemptAt: string | null;
  lastAttemptAt: string | null;
  deliveredAt: string | null;
  responseStatus: number | null;
  responseBody: string | null;
  lastError: string | null;
  durationMs: number | null;
  redeliveryOf: string | null;
  createdAt: string;
  payload: unknown;
}

export const DeliveryQuerySchema = z.object({
  endpointId: z.string().max(64).optional(),
  status: z.enum(["pending", "delivering", "succeeded", "dead"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.string().datetime().optional(),
});

export async function listDeliveries(
  workspaceId: string,
  q: z.infer<typeof DeliveryQuerySchema>,
): Promise<DeliveryView[]> {
  const rows = await withWorkspaceScope(workspaceId, (tx) =>
    tx.webhookDelivery.findMany({
      where: {
        workspaceId,
        ...(q.endpointId ? { endpointId: q.endpointId } : {}),
        ...(q.status ? { status: q.status } : {}),
        ...(q.before ? { createdAt: { lt: new Date(q.before) } } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: q.limit,
      include: { endpoint: { select: { url: true } } },
    }),
  );
  return rows.map((d) => ({
    id: d.id,
    endpointId: d.endpointId,
    endpointUrl: d.endpoint?.url ?? null,
    eventId: d.eventId,
    eventType: d.eventType,
    status: d.status,
    attempts: d.attempts,
    nextAttemptAt: d.status === "pending" ? d.nextAttemptAt.toISOString() : null,
    lastAttemptAt: d.lastAttemptAt?.toISOString() ?? null,
    deliveredAt: d.deliveredAt?.toISOString() ?? null,
    responseStatus: d.responseStatus,
    responseBody: d.responseBody,
    lastError: d.lastError,
    durationMs: d.durationMs,
    redeliveryOf: d.redeliveryOf,
    createdAt: d.createdAt.toISOString(),
    payload: d.payload,
  }));
}

/**
 * Manual redelivery: a NEW delivery row with the same event id + payload
 * (receivers dedupe on the event id), due now. The original row is kept as
 * history. Returns the new delivery id.
 */
export async function redeliver(workspaceId: string, deliveryId: string): Promise<string> {
  await requireEntitlement(workspaceId, "webhooks");
  return withWorkspaceScope(workspaceId, async (tx) => {
    const d = await tx.webhookDelivery.findFirst({
      where: { id: deliveryId, workspaceId },
      include: { endpoint: { select: { enabled: true } } },
    });
    if (!d) throw new NotFoundError("Delivery not found.");
    if (!d.endpoint?.enabled) throw new BadRequestError("Turn the endpoint on before redelivering.");
    const copy = await tx.webhookDelivery.create({
      data: {
        workspaceId,
        endpointId: d.endpointId,
        eventId: d.eventId,
        eventType: d.eventType,
        payload: d.payload as Prisma.InputJsonValue,
        redeliveryOf: d.id,
      },
      select: { id: true },
    });
    return copy.id;
  });
}
